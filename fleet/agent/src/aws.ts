/** The host agent's AWS implementations. Credentials come from the host's instance role. */
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { HostMetrics } from './ports.js';

/** F6's alarms read these: namespace `PaneCloud/Fleet`, dimension `Fleet=<fleet>`. */
export function cloudWatchHostMetrics(region: string, fleet = 'pane-cloud'): HostMetrics {
  const client = new CloudWatchClient({ region });
  const Dimensions = [{ Name: 'Fleet', Value: fleet }];
  return {
    async publish({ memoryUsedPercent }) {
      await client.send(
        new PutMetricDataCommand({
          Namespace: 'PaneCloud/Fleet',
          MetricData: [
            { MetricName: 'Heartbeat', Dimensions, Value: 1, Unit: 'Count' },
            { MetricName: 'MemoryUsedPercent', Dimensions, Value: memoryUsedPercent, Unit: 'Percent' },
          ],
        }),
      );
    },
  };
}
