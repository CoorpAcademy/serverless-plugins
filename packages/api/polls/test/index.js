import {promisify} from 'util';
import test from 'ava';
import {listPolls} from '..';

test('should pass', async t => {
  const ret = await promisify(listPolls)(null, null);
  t.deepEqual(ret, {});
  t.pass();
});
