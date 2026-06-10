// Tiny script: open ws to URL (arg 1), confirm handshake, exit 0.
import { WsClient } from './ws-client.mjs';
const url = process.argv[2];
const ws = new WsClient();
try {
  await ws.connect(url);
  console.log('handshake OK to', url);
  ws.close();
  setTimeout(() => process.exit(0), 50);
} catch (e) {
  console.error('handshake FAILED:', e.message);
  process.exit(1);
}
