import { CatalogueRepository } from './repository.js';
import { PlaceRepository } from './places.js';
import { SourceMetadataRepository } from './sources.js';

// Loaded only by the test harness; never bundled into the application.
export default {
  async fetch(request, env) {
    const repository = new CatalogueRepository(env.DB);
    if (new URL(request.url).pathname === '/metadata') {
      const places = new PlaceRepository(env.DB);
      const sources = new SourceMetadataRepository(env.DB);
      const place = await places.create({
        name: 'Worker place',
        kind: 'city',
        provenance: { kind: 'manual' },
      });
      const photo = await repository.createPhoto();
      const source = await sources.record(photo.photoId, {
        sha256: 'b'.repeat(64),
        originalFilename: 'synthetic-worker.jpg',
        parser: { name: 'test', version: '1' },
        rawMetadata: { Test: 'worker-private-marker' },
        gps: { latitude: 42, longitude: -70 },
      });
      const saved = await repository.savePhotoMetadataDraft(photo.photoId, 1, {
        sourceId: source.id,
        title: 'Worker metadata',
        rights: { creators: ['Élodie'] },
        capture: {
          precision: 'second',
          localDate: '2024-11-03',
          localTime: '01:30:00',
          offsetMinutes: -300,
          timeZone: 'America/Toronto',
          offsetSource: 'owner confirmed',
        },
        publicLocation: {
          visibility: 'place',
          place: { placeId: place.placeId, revision: place.revision },
        },
      });
      await env.DB.prepare('INSERT INTO published_photos VALUES (?, 2, 100)')
        .bind(photo.photoId)
        .run();
      return Response.json({
        revision: saved.revision,
        published: await repository.getPublishedPhotoMetadata(photo.photoId),
      });
    }
    const tag = await repository.createTag({
      name: 'Worker collection',
      slug: 'worker-collection',
      aliases: ['Worker alias'],
    });
    const photo = await repository.createPhoto([tag.tagId]);
    const next = await repository.savePhotoDraft(photo.photoId, 1, []);
    let conflict;
    try {
      await repository.savePhotoDraft(photo.photoId, 1, [tag.tagId]);
    } catch (error) {
      conflict = error.code;
    }
    return Response.json({
      tag,
      photo,
      next,
      conflict,
      resolved: await repository.findDraftTag('WORKER ALIAS'),
      published: await repository.listPublishedTagPhotos(tag.tagId),
    });
  },
};
