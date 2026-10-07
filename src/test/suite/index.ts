/** suite/index.ts — mocha runner inside the Extension Development Host. */
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  return new Promise((resolve, reject) => {
    try {
      mocha.run(failures => {
        if (failures > 0) { reject(new Error(`${failures} integration tests failed.`)); }
        else { resolve(); }
      });
    } catch (err) {
      reject(err);
    }
  });
}
