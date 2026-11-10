import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('the runner restarts', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'restart', params: {} });
});

Then('the app is connected again', async function (this: ThreadbearWorld) {
  // The mock answers `restart` first and drops every connection about 100 ms
  // later, then stays down for a few seconds. A dump taken straight after the
  // step above still says "connected", so wait for the app to see the drop
  // before waiting for it to come back, or this passes without a reconnect.
  await this.until('the connection to drop', (d) => d.connection !== 'connected');
  await this.until('the app connected again', (d) => d.connection === 'connected', 30_000);
});

Then('the transcript still shows the thread {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" still open with its rows`, (d) => d.selection?.title === title && d.transcript.rows.length > 0);
});
