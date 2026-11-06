#!/usr/bin/env node
/**
 * `fleet-agent serve-fleet [--config <file>]` runs the fleet API and scheduler.
 * `fleet-agent serve-host [--config <file>]` runs the host agent on a fleet host.
 *
 * Settings come from the JSON config file (every field has a default except the ones marked
 * required). Tokens never go in it: they come from the environment or from systemd credentials.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createHostNetwork } from '@pane-cloud/fleet-network';
import { createRuntime } from '@pane-cloud/fleet-runtime';
import { PaneRelease } from 'pane-cloud-contract';
import { z } from 'zod';
import { startFleet } from './fleet.js';
import { cloudWatchHostMetrics } from './aws.js';
import { createHostAgent, DEFAULT_EGRESS_POLICY } from './host.js';
import { adoptedVolumeRecovery, fileMaintenanceSignal, fleetFairUse, localDiagnosticsStore, localSnapshotStore, noHostMetrics, releasesFrom } from './local.js';
import { fileStore } from './store.js';

const TrustedKeys = z.record(z.string().min(1), z.string().startsWith('-----BEGIN PUBLIC KEY-----'));
/** A list of releases, or where to read it: a JSON file or an https URL. */
const Releases = z.union([z.array(PaneRelease), z.string().min(1)]);

const FleetConfig = z
  .object({
    listen: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().default(8080) }).default({ host: '0.0.0.0', port: 8080 }),
    trustedKeys: TrustedKeys,
    releases: Releases,
    stateFile: z.string().default('/var/lib/pane-fleet/fleet-state.json'),
    hostLostAfterSeconds: z.number().positive().default(120),
    newMachineMiB: z.number().positive().default(3072),
  })
  .strict();

const HostConfig = z
  .object({
    fleetUrl: z.url(),
    hostId: z.string().default(hostname()),
    trustedKeys: TrustedKeys,
    releases: Releases,
    dataDir: z.string().default('/srv/fleet'),
    firecrackerBin: z.string().default('/usr/local/bin/firecracker'),
    jailerBin: z.string().default('/usr/local/bin/jailer'),
    chrootBase: z.string().default('/srv/jailer'),
    cgroupParent: z.string().default('fleet'),
    maxMachines: z.number().int().positive().default(109),
    memoryTargetFraction: z.number().gt(0).lte(1).default(0.75),
    /** Until the S3 store exists: a directory every host can reach. */
    snapshotDir: z.string().default('/srv/fleet-snapshots'),
    diagnosticsDir: z.string().default('/srv/fleet-diagnostics'),
    /** Where a lost host's data volume is mounted, as `<dir>/<hostId>`. */
    adoptedDir: z.string().default('/srv/adopted'),
    /** Region for CloudWatch host metrics; defaults to AWS_REGION. With neither, metrics are off. */
    awsRegion: z.string().optional(),
    /** Overrides of the plan's egress thresholds (D-23 keeps the real ones in private config). */
    egress: z.object({ monthlyAlertBytes: z.number().positive(), abuseBytes: z.number().positive(), abuseWindowSeconds: z.number().positive() }).partial().default({}),
    /** The host drains while this file exists. */
    maintenanceFile: z.string().default('/run/pane-fleet/maintenance'),
  })
  .strict();

/** A token from the environment, or from the file systemd's LoadCredential= put in $CREDENTIALS_DIRECTORY. */
async function secret(envName: string, credential: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const dir = process.env.CREDENTIALS_DIRECTORY;
  const fromFile = dir ? (await readFile(join(dir, credential), 'utf8').catch(() => '')).trim() : '';
  if (fromFile) return fromFile;
  throw new Error(`Set ${envName}, or give the unit LoadCredential=${credential}:<file>.`);
}

async function readConfig<S extends z.ZodType>(schema: S, path: string): Promise<z.output<S>> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

function onSignal(close: () => Promise<void>) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }
}

async function main(argv: string[]): Promise<void> {
  const [mode, ...rest] = argv;
  const flag = rest.indexOf('--config');
  const configPath = flag >= 0 ? rest[flag + 1] : undefined;

  if (mode === 'serve-fleet') {
    const config = await readConfig(FleetConfig, configPath ?? '/etc/pane-fleet/fleet.json');
    const fleet = await startFleet(
      {
        serviceToken: await secret('FLEET_SERVICE_TOKEN', 'fleet-service-token'),
        hostToken: await secret('FLEET_HOST_TOKEN', 'fleet-host-token'),
        trustedKeys: config.trustedKeys,
        releases: releasesFrom(config.releases),
        store: fileStore(config.stateFile),
        hostLostAfterMs: config.hostLostAfterSeconds * 1000,
        newMachineMiB: config.newMachineMiB,
      },
      config.listen,
    );
    onSignal(fleet.close);
    return;
  }

  if (mode === 'serve-host') {
    const config = await readConfig(HostConfig, configPath ?? '/etc/pane-fleet/host.json');
    const region = config.awsRegion ?? process.env.AWS_REGION;
    if (!region) console.log(JSON.stringify({ msg: 'no AWS region; host metrics are off' }));
    const agent = await createHostAgent({
      hostId: config.hostId,
      fleetUrl: config.fleetUrl,
      token: await secret('FLEET_HOST_TOKEN', 'fleet-host-token'),
      trustedKeys: config.trustedKeys,
      runtime: createRuntime({ firecrackerBin: config.firecrackerBin, jailerBin: config.jailerBin, chrootBase: config.chrootBase, cgroupParent: config.cgroupParent }),
      releases: releasesFrom(config.releases),
      snapshots: localSnapshotStore(config.snapshotDir),
      diagnostics: localDiagnosticsStore(config.diagnosticsDir),
      volumes: adoptedVolumeRecovery({ mountRoot: config.adoptedDir }),
      maintenance: fileMaintenanceSignal(config.maintenanceFile),
      fairUse: fleetFairUse(join(config.dataDir, 'state', 'cpu-budget')),
      network: createHostNetwork(),
      hostMetrics: region ? cloudWatchHostMetrics(region) : noHostMetrics,
      egressPolicy: {
        ...DEFAULT_EGRESS_POLICY,
        ...(config.egress.monthlyAlertBytes ? { monthlyAlertBytes: config.egress.monthlyAlertBytes } : {}),
        ...(config.egress.abuseBytes ? { abuseBytes: config.egress.abuseBytes } : {}),
        ...(config.egress.abuseWindowSeconds ? { abuseWindowMs: config.egress.abuseWindowSeconds * 1000 } : {}),
      },
      store: fileStore(join(config.dataDir, 'agent-state.json')),
      dataDir: config.dataDir,
      kernelPath: join(config.dataDir, 'templates', 'vmlinux'),
      templatePath: join(config.dataDir, 'templates', 'guest.ext4'),
      maxMachines: config.maxMachines,
      memoryTargetFraction: config.memoryTargetFraction,
    });
    agent.start();
    onSignal(agent.close);
    return;
  }

  throw new Error('Usage: fleet-agent serve-fleet|serve-host [--config <file>]');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
