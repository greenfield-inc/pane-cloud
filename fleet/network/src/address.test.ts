import { describe, expect, test } from 'vitest';
import { addressForSlot } from './index.js';

describe('address plan', () => {
  test('slot 0 takes the first /30 of 10.200.0.0/16', () => {
    expect(addressForSlot('m-0', 0)).toEqual({
      tapName: 'fctap0',
      guestMac: '06:00:0a:c8:00:02',
      guestIp: '10.200.0.2',
      gatewayIp: '10.200.0.1',
      kernelIpArg: 'ip=10.200.0.2::10.200.0.1:255.255.255.252:m-0:eth0:off:10.200.0.1',
    });
  });

  test('slots are consecutive /30s and carry into the third octet', () => {
    expect(addressForSlot('a', 1)).toMatchObject({ gatewayIp: '10.200.0.5', guestIp: '10.200.0.6' });
    expect(addressForSlot('a', 64)).toMatchObject({ tapName: 'fctap64', gatewayIp: '10.200.1.1', guestIp: '10.200.1.2', guestMac: '06:00:0a:c8:01:02' });
  });

  test('a /16 holds 16,384 machines and no more', () => {
    expect(addressForSlot('a', 16_383)).toMatchObject({ gatewayIp: '10.200.255.253', guestIp: '10.200.255.254' });
    expect(() => addressForSlot('a', 16_384)).toThrow(RangeError);
    expect(() => addressForSlot('a', -1)).toThrow(RangeError);
    expect(() => addressForSlot('a', 1.5)).toThrow(RangeError);
  });

  test('another subnet moves the plan', () => {
    expect(addressForSlot('a', 2, '172.31.128.0/24')).toMatchObject({ gatewayIp: '172.31.128.9', guestIp: '172.31.128.10' });
    expect(() => addressForSlot('a', 64, '172.31.128.0/24')).toThrow(RangeError);
  });

  test('only contract machine ids reach the kernel arguments and nft', () => {
    expect(() => addressForSlot('m 1" ; flush ruleset', 0)).toThrow(TypeError);
    expect(() => addressForSlot('', 0)).toThrow(TypeError);
  });
});
