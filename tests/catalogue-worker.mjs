import { CatalogueRepository } from './repository.js';

// Loaded only by the test harness; never bundled into the application.
export default {
  async fetch(_request, env) {
    const repository = new CatalogueRepository(env.DB);
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
