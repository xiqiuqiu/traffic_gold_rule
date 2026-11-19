import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { OCR_ENGINE, recognizePage } from './paddleOcr';

test('单页 OCR 保留像素行框及置信度，并拒绝尺寸或来源不匹配的结果', async t => {
  const image = { png: Buffer.from('one rendered page'), width: 200, height: 100 };
  const reply = { width: 200, height: 100, engine: OCR_ENGINE,
    lines: [{ text: '责任结论', rawBox: [20, 30, 180, 50], confidence: 0.91 }] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.headers['content-type'] !== 'image/png' || !Buffer.concat(chunks).equals(image.png)) {
      res.writeHead(415).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const prior = process.env.PADDLE_OCR_URL;
  process.env.PADDLE_OCR_URL = `http://127.0.0.1:${address.port}/v1/ocr/lines`;
  t.after(() => {
    if (prior === undefined) delete process.env.PADDLE_OCR_URL;
    else process.env.PADDLE_OCR_URL = prior;
    server.close();
  });

  const result = await recognizePage(image);
  assert.deepEqual(result.lines[0], { ...reply.lines[0], bbox: [0.1, 0.3, 0.9, 0.5] });
  await assert.rejects(recognizePage({ ...image, width: 201 }), /尺寸/);
  reply.lines[0].rawBox[2] = 201;
  await assert.rejects(recognizePage(image), /越界/);
  reply.lines = [];
  assert.deepEqual((await recognizePage(image)).lines, []);
  reply.engine = 'unknown';
  await assert.rejects(recognizePage(image), /引擎版本/);
});
