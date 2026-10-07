import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowPath = '.github/workflows/update-studio.yml';
const templatePath = 'scripts/templates/update-studio.yml';

export function installUpdateWorkflow({ root = projectRoot } = {}) {
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== '@zeropress/studio') {
    throw new Error('Run this command in a ZeroPress Studio installation.');
  }
  const contents = readFileSync(join(root, templatePath));
  for (const path of ['.github', '.github/workflows', workflowPath]) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (path === workflowPath ? !stat.isFile() : !stat.isDirectory()))) {
      throw new Error(`Cannot install the workflow: ${path} must be a regular ${path === workflowPath ? 'file' : 'directory'}.`);
    }
  }
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  try {
    writeFileSync(join(root, workflowPath), contents, { flag: 'wx' });
    return { created: true, path: workflowPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(join(root, workflowPath)).equals(contents)) return { created: false, path: workflowPath };
    throw new Error(`${workflowPath} already exists with different contents. Compare it with ${templatePath} and review the changes manually. Your workflow has been preserved.`);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log('Usage: node scripts/install-update-studio.mjs\nCreate the Update Studio workflow, then commit and push it to your installation repository\'s default branch.');
    } else {
      if (args.length) throw new Error('Usage: node scripts/install-update-studio.mjs');
      const result = installUpdateWorkflow();
      console.log(styleText('green', result.created ? `Created ${result.path}.` : 'The Update Studio workflow is already installed.'));
      console.log('Commit and push the workflow to your installation repository\'s default branch.');
      console.log('Enable "Allow GitHub Actions to create and approve pull requests" in Settings > Actions > General.');
      console.log('Then open Actions > Update Studio > Run workflow.');
    }
  } catch (error) {
    console.error(styleText(['bold', 'red'], 'Cannot install the Update Studio workflow.', { stream: process.stderr }));
    console.error(error.message);
    process.exitCode = 1;
  }
}
