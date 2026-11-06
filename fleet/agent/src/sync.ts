/**
 * The one call between a host agent and the fleet API. Hosts have no inbound ports (F6), so each
 * host calls the fleet: it reports its machines, operation results and events, and receives its work.
 */
import { FleetEvent, FleetMachine, MachineId, MachineMetrics, OperationEnvelope, OperationStatus, type Route } from 'pane-cloud-contract';
import { z } from 'zod';

export const HostId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const HostReport = z
  .object({
    hostId: HostId,
    /** The host is stopping its machines for maintenance; place nothing on it. */
    draining: z.boolean(),
    maxMachines: z.number().int().nonnegative(),
    activeMachines: z.number().int().nonnegative(),
    /** Memory the host may use for machines under F4's overcommit target, and what it uses now. */
    memoryTargetMiB: z.number().nonnegative(),
    memoryUsedMiB: z.number().nonnegative(),
    machines: z.array(z.object({ machine: FleetMachine, metrics: MachineMetrics.nullable() }).strict()),
    /** Operations whose status changed since the last sync the fleet answered. */
    operations: z.array(OperationStatus),
    /** Events the fleet has not acknowledged yet, oldest first; ids are the host's own. */
    events: z.array(FleetEvent),
  })
  .strict();
export type HostReport = z.infer<typeof HostReport>;

export const Work = z.discriminatedUnion('kind', [
  /** A signed operation, exactly as the service sent it. The host verifies it again. */
  z.object({ kind: z.literal('operation'), envelope: OperationEnvelope }).strict(),
  /** Boot a machine from its disk on a lost host's data volume. */
  z.object({ kind: z.literal('recover'), machineId: MachineId, fromHostId: HostId }).strict(),
]);
export type Work = z.infer<typeof Work>;

export const SyncAnswer = z
  .object({
    work: z.array(Work),
    /** The last host event id the fleet has stored; the host drops it and everything before it. */
    eventsAck: z.string().nullable(),
  })
  .strict();
export type SyncAnswer = z.infer<typeof SyncAnswer>;

export const syncRoute: Route<typeof HostReport, z.ZodObject<Record<never, never>>, typeof SyncAnswer> = {
  id: 'fleet.hostSync',
  method: 'POST',
  path: '/v1/hosts/:hostId/sync',
  auth: true,
  body: HostReport,
  query: null,
  response: SyncAnswer,
  status: 200,
};
