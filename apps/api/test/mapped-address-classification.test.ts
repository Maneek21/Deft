import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAllowedSelfHostedPrivateAddress,
  isNeverAllowedMetadataAddress,
  isPublicNetworkAddress,
  validateMcpHttpUrl,
} from '@deft/mcp';
import { isPublicFetchAddress } from '../src/lib/public-http-fetch.js';

const MAPPED_METADATA = ['::ffff:168.63.129.16', '::ffff:a83f:8110', '::ffff:192.80.8.124', '::ffff:c050:87c', '::ffff:169.254.169.254'];

test('IPv4-mapped IPv6 addresses are classified by their IPv4 address', () => {
  for (const address of MAPPED_METADATA) {
    assert.equal(isNeverAllowedMetadataAddress(address), true, address);
    assert.equal(isPublicFetchAddress(address), false, address);
    assert.notEqual(validateMcpHttpUrl(new URL(`https://[${address}]/mcp`)), null, address);
  }
  assert.equal(isPublicFetchAddress('::ffff:8.8.8.8%1'), false);
  assert.equal(isPublicFetchAddress('::ffff:808:808%eth0'), false);
  const pairs = [
    ['::ffff:8.8.8.8', '8.8.8.8'], ['::ffff:808:808', '8.8.8.8'], ['::ffff:10.0.0.1', '10.0.0.1'],
    ['0:0:0:0:0:FFFF:0808:0808', '8.8.8.8'], ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe', '169.254.169.254'],
  ];
  for (const [mapped, v4] of pairs) {
    assert.equal(isPublicNetworkAddress(mapped!), isPublicNetworkAddress(v4!), mapped);
    assert.equal(isPublicFetchAddress(mapped!), isPublicFetchAddress(v4!), mapped);
    assert.equal(isAllowedSelfHostedPrivateAddress(mapped!), isAllowedSelfHostedPrivateAddress(v4!), mapped);
    assert.equal(isNeverAllowedMetadataAddress(mapped!), isNeverAllowedMetadataAddress(v4!), mapped);
  }
});
