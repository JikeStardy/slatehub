import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { MultipartParser } from './multipart-parser';

describe('MultipartParser', () => {
  it('preserves normalized image MIME metadata from the upload header', async () => {
    const parser = new MultipartParser();
    const image = Buffer.from('png bytes');
    const req = {
      isMultipart: () => true,
      parts: async function* () {
        yield {
          type: 'file',
          fieldname: 'image',
          mimetype: 'image/png; charset=binary',
          file: Readable.from([image]),
        };
      },
    } as unknown as FastifyRequest;

    const parsed = await parser.parseContentUpload(req);

    expect(parsed).toMatchObject({
      hasImage: true,
      imageBuf: image,
      imageMimeType: 'image/png',
    });
  });
});
