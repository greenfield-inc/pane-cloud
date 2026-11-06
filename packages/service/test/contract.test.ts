import { serviceContractCases } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { type Harness, startHarness } from './support/harness';

const users = {
  owner: { id: 501, login: 'octo-owner', name: 'Owner' },
  teammate: { id: 502, login: 'octo-mate', name: 'Teammate' },
  outsider: { id: 503, login: 'octo-stranger' },
};

describe('the service passes P0’s service contract against the fleet stub', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
    await harness.cohort(users.owner.login);
  });
  afterAll(() => harness.close());

  const cases = serviceContractCases({
    get baseUrl() {
      return harness.url;
    },
    logins: { owner: users.owner.login, teammate: users.teammate.login, outsider: users.outsider.login },
    timeoutMs: 5000,
    signIn: (who) => harness.signIn(users[who]),
  });
  for (const c of cases) it(c.name, () => c.run());
});
