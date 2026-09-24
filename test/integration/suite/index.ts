import * as path from 'path';
import Mocha = require('mocha');

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  mocha.addFile(path.join(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
