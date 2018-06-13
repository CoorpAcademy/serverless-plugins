import {promisify} from 'util';
import test from 'ava';
import {getPoll} from '..';

test('should pass', async t => {
  const ret = await promisify(getPoll)(null, null);
  t.deepEqual(ret, {
    statusCode: 200,
    body: '{"question":"pariatur"}'
  });
  t.pass();
});
