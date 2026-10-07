import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { updateMetadata } from './passkey-metadata.mjs';

export async function runMetadataUpdate(args, { update = updateMetadata, log = console.log, error = console.error } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      log('npm run update:passkey-metadata -- [full-name-source-commit]\nUpdates MDS when downloads are allowed; otherwise reuses and verifies the local signed cache. Supplemental names are checked independently. Regenerates metadata in both cases. Certificate verification may check CRLs. This command does not run during build or deployment.');
      return 0;
    }
    if (args.length > 1 || (args.length === 1 && !/^[a-f0-9]{40}$/u.test(args[0]))) {
      throw new Error('Expected no argument or a full supplemental source commit SHA. Use --help for usage.');
    }
    const result = await update({ namesCommit: args[0] });
    const status = {
      downloaded: 'MDS downloaded and verified.',
      not_modified: 'MDS checked: no new version (HTTP 304). Cached MDS verified.',
      cached: 'MDS cache reused and verified; no MDS update request was made.',
      resumed: 'Resumed cached MDS verification and generation; no MDS update request was made.',
    }[result.mds.status];
    log(status);
    if (result.mds.nextCheckAt) log('Next MDS update request allowed after ' + result.mds.nextCheckAt + '.');
    log(styleText('green', 'Passkey metadata generated.') + ' MDS ' + result.serial + ', ' + result.models + ' models.');
    log('Supplemental names: ' + result.namesCommit + '.');
    return 0;
  } catch (cause) {
    error(styleText(['bold', 'red'], 'Cannot update passkey metadata.', { stream: process.stderr }));
    error(cause instanceof Error ? cause.message : 'Unexpected metadata failure.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMetadataUpdate(process.argv.slice(2));
}
