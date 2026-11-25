import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import { SourceMetadataRepository } from '../src/catalogue/sources.ts';
import { PlaceRepository } from '../src/catalogue/places.ts';
import { normalizeCapture } from '../src/catalogue/metadata.ts';
import { offsetsAtLocalTime } from '../src/photo-review/time-zone.ts';
import { jpegDateTags } from '../src/photo-review/jpeg-date-tags.ts';
import {
  captureDatesDisagree,
  embeddedDates,
} from '../src/photo-review/embedded-dates.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

it('compares capture dates across groups without flagging equivalent UTC or separate edit dates', () => {
  const tags = {
    'ExifIFD:DateTimeOriginal': '2024:07:01 23:50:10',
    'ExifIFD:SubSecTimeOriginal': '040',
    'ExifIFD:OffsetTimeOriginal': '-04:00',
    'XMP-photoshop:DateCreated': '2024-07-02T03:50:10.04Z',
    'IFD0:ModifyDate': '2025:12:20 15:00:00',
  };
  const result = embeddedDates(tags);
  assert.deepEqual(
    result.map((date) => date.purpose),
    ['capture', 'capture', 'other'],
  );
  assert.equal(captureDatesDisagree(result), false);
  assert.equal(
    captureDatesDisagree(
      embeddedDates({
        ...tags,
        'IPTC:DateCreated': '2019:11:23',
        'IPTC:TimeCreated': '15:25:00-05:00',
      }),
    ),
    true,
  );
  assert.equal(
    captureDatesDisagree(
      embeddedDates({
        ...tags,
        'XMP-photoshop:DateCreated': '2024-07-02T03:50:10.041Z',
      }),
    ),
    true,
  );
});

it('preserves date-only and unknown-offset metadata and exposes malformed values without selecting them', () => {
  const dates = embeddedDates({
    'ExifIFD:DateTimeOriginal': '2024:02:31 12:50:10',
    'XMP-exif:DateTimeOriginal': '2024-02-29T13:00:00-00:00',
    'XMP-photoshop:DateCreated': '2024-02-29T13:00:00+14:30',
    'IPTC:DateCreated': '2024:02:29',
  });
  assert.equal(dates[0].value, null);
  assert.match(dates[0].raw, /2024:02:31/);
  assert.deepEqual(dates[1].value, {
    date: '2024-02-29',
    time: '13:00:00',
    fraction: null,
    offset: null,
  });
  assert.equal(dates[2].value, null);
  assert.deepEqual(dates[3].value, {
    date: '2024-02-29',
    time: null,
    fraction: null,
    offset: null,
  });
  assert.equal(captureDatesDisagree(dates), false);
});

it('resolves historical named-zone offsets and distinguishes repeated and skipped camera times', () => {
  assert.deepEqual(
    offsetsAtLocalTime('2024-11-03', '01:30:00', 'America/Toronto'),
    [-240, -300],
  );
  assert.deepEqual(
    offsetsAtLocalTime('2024-03-10', '02:30:00', 'America/Toronto'),
    [],
  );
  assert.deepEqual(
    offsetsAtLocalTime('2024-07-01', '12:00:00', 'America/Toronto'),
    [-240],
  );
  assert.deepEqual(
    offsetsAtLocalTime('2024-01-01', '12:00:00', 'America/Toronto'),
    [-300],
  );
  assert.deepEqual(
    offsetsAtLocalTime('2024-07-01', '12:00:00', 'Asia/Kathmandu'),
    [345],
  );
  assert.throws(
    () => offsetsAtLocalTime('1900-07-01', '12:00:00', 'Asia/Kathmandu'),
    /cannot be stored exactly/,
  );
});

it('projects the saved capture to JPEG date fields even when the original capture value is unchanged', () => {
  const capture = normalizeCapture({
    precision: 'second',
    localDate: '2024-07-01',
    localTime: '23:50:10',
    subseconds: '040',
    offsetMinutes: -240,
    offsetSource: 'Owner confirmed',
  });
  const fields = jpegDateTags(capture, { 'GPS:GPSDateStamp': '2012:01:01' });
  for (const field of ['DateTimeOriginal', 'CreateDate', 'ModifyDate'])
    assert.equal(fields[`EXIF:${field}`], '2024:07:01 23:50:10');
  assert.equal(fields['EXIF:OffsetTimeDigitized'], '-04:00');
  assert.equal(fields['EXIF:SubSecTime'], '040');
  assert.equal(fields['IPTC:DigitalCreationTime'], '23:50:10-04:00');
  assert.equal(fields['XMP-xmp:MetadataDate'], '2024:07:01 23:50:10.040-04:00');
  assert.equal(fields['GPS:GPSDateStamp'], '2024:07:02');
  assert.equal(fields['GPS:GPSTimeStamp'], '03:50:10.040');
  assert.equal(fields['XMP-exif:GPSDateTime'], undefined);

  const floating = jpegDateTags(
    normalizeCapture({ ...capture, offsetMinutes: null, offsetSource: null }),
    { 'GPS:GPSDateStamp': '2012:01:01' },
  );
  assert.equal(floating['EXIF:OffsetTimeOriginal'], '');
  assert.equal(floating['IPTC:TimeCreated'], '');
  assert.equal(floating['GPS:GPSDateStamp'], '');
  assert.equal(
    floating['XMP-exif:DateTimeOriginal'],
    '2024:07:01 23:50:10.040',
  );

  const day = jpegDateTags(
    normalizeCapture({ precision: 'date', localDate: '2024-07-01' }),
    {},
  );
  assert.equal(day['EXIF:DateTimeOriginal'], '');
  assert.equal(day['IPTC:DateCreated'], '2024:07:01');
  assert.equal(day['XMP-photoshop:DateCreated'], '2024:07:01');
});

describe('metadata, evidence, and places on local D1', () => {
  let local, db, catalogue, sources, places;
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  const errorCode = (code) => (error) => error.code === code;
  const ref = (place) => ({ placeId: place.placeId, revision: place.revision });
  const placeInput = (name = 'Québec', parent = null) => ({
    name,
    kind: 'city',
    parent,
    provenance: { kind: 'manual' },
  });
  const evidenceInput = () => ({
    sha256: 'a'.repeat(64),
    originalFilename: 'synthetic-source.jpg',
    parser: { name: 'synthetic-parser', version: '1' },
    rawMetadata: {
      DateTimeOriginal: '2024:11:03 01:30:00',
      OffsetTimeOriginal: '-04:00',
      GPSLatitude: 'private-latitude',
      Comment: 'private-source-marker',
      Artist: ['Élodie', '李'],
    },
    captureText: '2024:11:03 01:30:00',
    captureSubseconds: '123456789',
    captureOffsetText: '-04:00',
    gps: { latitude: 46.81234567, longitude: -71.21234567 },
  });
  const metadataInput = (sourceId, place) => ({
    sourceId,
    title: 'Soirée à Québec',
    caption: 'A harbour — 運河',
    altText: 'Boats at dusk',
    keywords: ['boats', 'été'],
    rights: {
      creators: ['Élodie', '李'],
      copyrightOwners: ['Example owner'],
      copyrightNotice: '© 2024 Example owner',
      creditLine: 'Élodie / Example',
      usageTerms: 'All rights reserved.',
      rightsUrl: 'https://example.test/rights',
      publicContactUrl: 'mailto:contact@example.test',
    },
    capture: {
      precision: 'second',
      localDate: '2024-11-03',
      localTime: '01:30:00',
      subseconds: '123456789',
      offsetMinutes: -240,
      timeZone: 'America/Toronto',
      offsetSource: 'private-offset-decision',
      clockCorrectionSeconds: -60,
      correctionReason: 'private-clock-correction',
    },
    privateLocation: {
      place: ref(place),
      point: { latitude: 46.81234567, longitude: -71.21234567 },
    },
    publicLocation: { visibility: 'place', place: ref(place) },
  });

  before(async () => {
    local = await createLocalCatalogue();
    db = local.db;
    await applyLocalMigrations(db);
    catalogue = new CatalogueRepository(db);
    sources = new SourceMetadataRepository(db);
    places = new PlaceRepository(db);
  });
  after(async () => local?.close());

  it('runs metadata, source, place and private-field filtering inside the Worker', async () => {
    const response = await local.fetch('http://catalogue.test/metadata');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.revision, 2);
    assert.equal(result.published.title, 'Worker metadata');
    assert.equal(result.published.capture.utcInstant, '2024-11-03T06:30:00Z');
    assert.deepEqual(result.published.rights.creators, ['Élodie']);
    assert.equal(result.published.publicLocation.visibility, 'place');
    assert(!JSON.stringify(result).includes('worker-private-marker'));
    assert(!JSON.stringify(result).includes('sourceId'));
  });

  it('saves curated capture separately from original EXIF while preserving other draft details', async () => {
    const tag = await catalogue.createTag({ name: 'Capture fixture' });
    const place = await places.create(placeInput());
    const photo = await catalogue.createPhoto([tag.tagId]);
    const initial = await catalogue.savePhotoMetadataDraft(
      photo.photoId,
      photo.revision,
      metadataInput(null, place),
    );
    const evidence = evidenceInput();
    const saved = await catalogue.savePhotoCaptureDraft(
      photo.photoId,
      initial.revision,
      {
        precision: 'second',
        localDate: '2024-11-03',
        localTime: '01:35:27',
        subseconds: '040',
        offsetMinutes: -300,
      },
      evidence,
    );
    assert.equal(saved.capture.utcInstant, '2024-11-03T06:35:27.040Z');
    assert.equal(saved.capture.offsetSource, 'Owner confirmed');
    assert.deepEqual(saved.original, {
      dateTime: evidence.captureText,
      subseconds: evidence.captureSubseconds,
      offset: evidence.captureOffsetText,
    });
    assert.deepEqual(
      await catalogue.getPhotoCaptureDraft(photo.photoId),
      saved,
    );
    const persisted = await catalogue.getPhotoDraft(photo.photoId);
    assert.deepEqual(persisted.tagIds, initial.tagIds);
    const { capture: _capture, sourceId, ...other } = persisted.metadata;
    const {
      capture: _previous,
      sourceId: _previousSource,
      ...initialOther
    } = initial.metadata;
    assert.deepEqual(other, initialOther);
    assert.deepEqual(
      (await sources.get(sourceId)).rawMetadata,
      evidence.rawMetadata,
    );

    await assert.rejects(
      catalogue.savePhotoCaptureDraft(
        photo.photoId,
        saved.revision,
        { precision: 'unknown' },
        { ...evidence, sha256: 'b'.repeat(64) },
      ),
      errorCode('invalid_input'),
    );
    const dateOnly = await catalogue.savePhotoCaptureDraft(
      photo.photoId,
      saved.revision,
      { precision: 'date', localDate: '2024-11-03' },
    );
    assert.equal(dateOnly.capture.localTime, null);
    assert.equal(dateOnly.capture.utcInstant, null);
    assert.deepEqual(dateOnly.original, saved.original);
    assert.equal(
      (await catalogue.getPhotoDraft(photo.photoId)).metadata.sourceId,
      sourceId,
    );
  });

  it('rolls back captured EXIF when a competing edit wins after the draft is read', async () => {
    const photo = await catalogue.createPhoto();
    const stale = new CatalogueRepository({
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        await catalogue.savePhotoMetadataDraft(photo.photoId, photo.revision, {
          title: 'Concurrent title',
        });
        return db.batch(statements);
      },
    });
    await assert.rejects(
      stale.savePhotoCaptureDraft(
        photo.photoId,
        photo.revision,
        { precision: 'date', localDate: '2024-11-03' },
        evidenceInput(),
      ),
      errorCode('conflict'),
    );
    assert.equal(
      (await catalogue.getPhotoDraft(photo.photoId)).metadata.title,
      'Concurrent title',
    );
    assert.equal(
      await statement(
        'SELECT id FROM photo_source_metadata WHERE photo_id = ?',
        photo.photoId,
      ).first(),
      null,
    );
  });

  it('upgrades a populated first-migration catalogue without changing its records', async () => {
    const old = await createLocalCatalogue();
    try {
      await applyLocalMigrations(old.db, '0001_catalogue.sql');
      await old.db.batch([
        old.db.prepare(
          "INSERT INTO tags (id, created_at) VALUES ('legacy-tag', 0)",
        ),
        old.db.prepare(
          "INSERT INTO tag_revisions VALUES ('legacy-tag', 1, 0, 'Legacy', 'legacy', 'legacy')",
        ),
        old.db.prepare(
          "UPDATE tags SET draft_revision = 1 WHERE id = 'legacy-tag'",
        ),
        old.db.prepare(
          "INSERT INTO photos (id, created_at) VALUES ('legacy-photo', 0)",
        ),
        old.db.prepare(
          "INSERT INTO photo_tags VALUES ('legacy-photo', 1, 'legacy-tag')",
        ),
        old.db.prepare(
          "INSERT INTO photo_revisions VALUES ('legacy-photo', 1, 0)",
        ),
        old.db.prepare(
          "UPDATE photos SET draft_revision = 1 WHERE id = 'legacy-photo'",
        ),
        old.db.prepare("INSERT INTO published_tags VALUES ('legacy-tag', 1)"),
        old.db.prepare(
          "INSERT INTO published_photos VALUES ('legacy-photo', 1, 100)",
        ),
        old.db.prepare(
          "INSERT INTO published_photo_tags VALUES ('legacy-photo', 1, 'legacy-tag', 100)",
        ),
      ]);
      await applyLocalMigrations(old.db);
      await applyLocalMigrations(old.db);
      const upgraded = new CatalogueRepository(old.db);
      const photo = await upgraded.getPhotoDraft('legacy-photo');
      assert.deepEqual(photo.tagIds, ['legacy-tag']);
      assert.equal(photo.revision, 1);
      assert.equal(photo.metadata, null);
      assert.equal(
        (await upgraded.listPublishedTagPhotos('legacy-tag'))[0]
          .firstPublishedAt,
        100,
      );
      assert.equal(
        await upgraded.getPublishedPhotoMetadata('legacy-photo'),
        null,
      );
      const next = await upgraded.savePhotoMetadataDraft('legacy-photo', 1, {
        title: 'After migration',
      });
      assert.equal(next.metadata.title, 'After migration');
      assert.deepEqual(next.tagIds, ['legacy-tag']);
      assert.deepEqual(
        (await old.db.prepare('PRAGMA foreign_key_check').all()).results,
        [],
      );
    } finally {
      await old.close();
    }
  });

  it('round-trips immutable source evidence without rewriting original date text or private fields', async () => {
    const photo = await catalogue.createPhoto();
    const input = evidenceInput();
    const source = await sources.record(photo.photoId, input, 1234);
    assert.deepEqual(await sources.get(source.id), {
      ...input,
      id: source.id,
      photoId: photo.photoId,
      extractedAt: 1234,
    });
    await assert.rejects(
      statement(
        'UPDATE photo_source_metadata SET capture_text = ? WHERE id = ?',
        'changed',
        source.id,
      ).run(),
    );
    await assert.rejects(
      statement(
        'DELETE FROM photo_source_metadata WHERE id = ?',
        source.id,
      ).run(),
    );
    await assert.rejects(
      sources.record(photo.photoId, input),
      errorCode('conflict'),
    );
    const reparsed = await sources.record(photo.photoId, {
      ...input,
      parser: { ...input.parser, version: '2' },
    });
    assert.notEqual(reparsed.id, source.id);
    assert.equal((await sources.get(source.id)).captureText, input.captureText);
  });

  it('rejects lossy, oversized, cyclic source values and invalid source coordinates', async () => {
    const photo = await catalogue.createPhoto();
    const cyclic = {};
    cyclic.self = cyclic;
    for (const rawMetadata of [
      { bad: NaN },
      { bad: undefined },
      { bad: new Date() },
      cyclic,
      { huge: 'x'.repeat(262145) },
    ]) {
      await assert.rejects(
        sources.record(photo.photoId, { ...evidenceInput(), rawMetadata }),
        errorCode('invalid_input'),
      );
    }
    await assert.rejects(
      sources.record(photo.photoId, {
        ...evidenceInput(),
        gps: { latitude: 91, longitude: 0 },
      }),
      errorCode('invalid_input'),
    );
    await assert.rejects(sources.record('missing-photo', evidenceInput()));
    assert.equal(
      await statement(
        'SELECT id FROM photo_source_metadata WHERE photo_id = ?',
        photo.photoId,
      ).first(),
      null,
    );
  });

  it('round-trips description, distinct rights fields, nanosecond text and curated locations', async () => {
    const photo = await catalogue.createPhoto();
    const place = await places.create(placeInput());
    const source = await sources.record(photo.photoId, evidenceInput());
    const input = metadataInput(source.id, place);
    const saved = await catalogue.savePhotoMetadataDraft(
      photo.photoId,
      1,
      input,
      2000,
    );
    assert.equal(saved.revision, 2);
    assert.equal(saved.createdAt, 2000);
    const { utcInstant, ...capture } = saved.metadata.capture;
    assert.equal(utcInstant, '2024-11-03T05:30:00.123456789Z');
    assert.deepEqual(capture, input.capture);
    assert.deepEqual(saved.metadata.rights, input.rights);
    assert.equal(saved.metadata.sourceId, source.id);
    assert.deepEqual(saved.metadata.privateLocation, input.privateLocation);
    assert.deepEqual(saved.metadata.publicLocation, input.publicLocation);
    assert.deepEqual(saved.metadata.keywords, ['boats', 'été']);
    assert.equal(saved.metadata.title, input.title);
    assert.equal(saved.metadata.caption, input.caption);
    assert.equal(await catalogue.getPhotoRevision(photo.photoId, 1), null);
    assert.equal(
      (await sources.get(source.id)).captureText,
      '2024:11:03 01:30:00',
    );
  });

  it('retains metadata on tag-only edits and retains tags on metadata-only edits', async () => {
    const tag = await catalogue.createTag({
      name: 'Metadata boats',
    });
    const photo = await catalogue.createPhoto([tag.tagId]);
    const saved = await catalogue.savePhotoMetadataDraft(photo.photoId, 1, {
      title: 'Keep me',
      rights: { copyrightNotice: '© 1998 Example' },
    });
    assert.deepEqual(saved.tagIds, [tag.tagId]);
    const tagged = await catalogue.savePhotoDraft(photo.photoId, 2, []);
    assert.deepEqual(tagged.metadata, saved.metadata);
    assert.deepEqual(tagged.tagIds, []);
    assert.equal(tagged.metadata.rights.copyrightNotice, '© 1998 Example');
    const cleared = await catalogue.savePhotoMetadataDraft(
      photo.photoId,
      3,
      {},
    );
    assert.equal(cleared.metadata.title, null);
    assert.deepEqual(cleared.metadata.rights.creators, []);
    assert.equal(await catalogue.getPhotoRevision(photo.photoId, 2), null);
  });

  it('preserves unknown, date-only, and offset-free capture uncertainty', () => {
    const unknown = normalizeCapture();
    assert.equal(unknown.precision, 'unknown');
    assert.equal(unknown.utcInstant, null);
    assert.equal(unknown.localDate, null);
    const date = normalizeCapture({
      precision: 'date',
      localDate: '2024-02-29',
    });
    assert.equal(date.localTime, null);
    assert.equal(date.utcInstant, null);
    const localTime = normalizeCapture({
      precision: 'second',
      localDate: '2024-11-03',
      localTime: '01:30:00',
    });
    assert.equal(localTime.offsetMinutes, null);
    assert.equal(localTime.timeZone, null);
    assert.equal(localTime.utcInstant, null);
    const zoneOnly = normalizeCapture({
      precision: 'second',
      localDate: '2024-11-03',
      localTime: '01:30:00',
      timeZone: 'America/Toronto',
      offsetSource: 'Owner-supplied zone, offset unconfirmed',
    });
    assert.equal(zoneOnly.utcInstant, null);
  });

  it('derives UTC only from an explicit offset, preserving DST choices and calendar rollovers', () => {
    const base = {
      precision: 'second',
      localDate: '2024-11-03',
      localTime: '01:30:00',
      offsetSource: 'Owner confirmed',
    };
    assert.equal(
      normalizeCapture({ ...base, offsetMinutes: -240 }).utcInstant,
      '2024-11-03T05:30:00Z',
    );
    assert.equal(
      normalizeCapture({ ...base, offsetMinutes: -300 }).utcInstant,
      '2024-11-03T06:30:00Z',
    );
    assert.equal(
      normalizeCapture({
        ...base,
        localDate: '2024-01-01',
        localTime: '00:15:00',
        offsetMinutes: 345,
        subseconds: '000001',
      }).utcInstant,
      '2023-12-31T18:30:00.000001Z',
    );
    assert.equal(
      normalizeCapture({ ...base, localDate: '0099-12-31', offsetMinutes: 0 })
        .utcInstant,
      '0099-12-31T01:30:00Z',
    );
  });

  it('rejects invented precision, invalid dates, unsupported seconds, and unexplained corrections', () => {
    const bad = [
      { precision: 'unknown', localDate: '2024-01-01' },
      { precision: 'date', localDate: '2023-02-29' },
      { precision: 'date', localDate: '2024-02-30' },
      { precision: 'date', localDate: '0000-01-01' },
      { precision: 'date', localDate: '2024-01-01', offsetMinutes: 0 },
      { precision: 'second', localDate: '2024-01-01', localTime: '24:00:00' },
      { precision: 'second', localDate: '2024-01-01', localTime: '23:59:60' },
      {
        precision: 'second',
        localDate: '2024-01-01',
        localTime: '00:00:00',
        offsetMinutes: 0,
      },
      {
        precision: 'second',
        localDate: '2024-01-01',
        localTime: '00:00:00',
        clockCorrectionSeconds: 60,
      },
      {
        precision: 'date',
        localDate: '2024-01-01',
        timeZone: 'made-up-zone',
        offsetSource: 'owner',
      },
    ];
    for (const input of bad)
      assert.throws(() => normalizeCapture(input), errorCode('invalid_input'));
  });

  it('keeps public metadata pinned while drafts change and excludes every private storage field', async () => {
    const photo = await catalogue.createPhoto();
    const place = await places.create(placeInput('Public Québec'));
    const source = await sources.record(photo.photoId, evidenceInput());
    const saved = await catalogue.savePhotoMetadataDraft(
      photo.photoId,
      1,
      metadataInput(source.id, place),
    );
    assert.equal(
      await catalogue.getPublishedPhotoMetadata(photo.photoId),
      null,
    );
    await statement(
      'INSERT INTO published_photos VALUES (?, ?, ?)',
      photo.photoId,
      2,
      9876,
    ).run();
    const published = await catalogue.getPublishedPhotoMetadata(photo.photoId);
    assert.equal(published.title, saved.metadata.title);
    assert.deepEqual(published.publicLocation, {
      visibility: 'place',
      place: ref(place),
    });
    const output = JSON.stringify(published);
    for (const secret of [
      'sourceId',
      source.id,
      'originalFilename',
      'rawMetadata',
      'privateLocation',
      '46.81234567',
      '-71.21234567',
      'offsetSource',
      'correctionReason',
      'clockCorrectionSeconds',
      'private-source-marker',
      'private-offset-decision',
      'private-clock-correction',
    ])
      assert(!output.includes(secret), `Private field leaked: ${secret}`);
    await catalogue.savePhotoMetadataDraft(photo.photoId, 2, {
      title: 'Unpublished title',
      publicLocation: { visibility: 'none' },
    });
    assert.deepEqual(
      await catalogue.getPublishedPhotoMetadata(photo.photoId),
      published,
    );
    assert.equal(
      (
        await statement(
          'SELECT first_published_at FROM published_photos WHERE photo_id = ?',
          photo.photoId,
        ).first()
      ).first_published_at,
      9876,
    );
    await statement(
      'DELETE FROM published_photos WHERE photo_id = ?',
      photo.photoId,
    ).run();
    assert.equal(
      await catalogue.getPublishedPhotoMetadata(photo.photoId),
      null,
    );
  });

  it('defaults location to hidden and round-trips only explicitly selected public points', async () => {
    const photo = await catalogue.createPhoto();
    const privateOnly = await catalogue.savePhotoMetadataDraft(
      photo.photoId,
      1,
      { privateLocation: { point: { latitude: 45, longitude: -73 } } },
    );
    assert.deepEqual(privateOnly.metadata.publicLocation, {
      visibility: 'none',
    });
    const approximate = {
      visibility: 'approximate',
      place: null,
      point: { latitude: 45.5, longitude: -73.5 },
      radiusMeters: 5000,
    };
    const coarse = await catalogue.savePhotoMetadataDraft(photo.photoId, 2, {
      publicLocation: approximate,
    });
    assert.deepEqual(coarse.metadata.publicLocation, approximate);
    const exact = {
      visibility: 'exact',
      place: null,
      point: { latitude: 0, longitude: 0 },
    };
    const precise = await catalogue.savePhotoMetadataDraft(photo.photoId, 3, {
      publicLocation: exact,
    });
    assert.deepEqual(precise.metadata.publicLocation, exact);
    await assert.rejects(
      catalogue.savePhotoMetadataDraft(photo.photoId, 4, {
        publicLocation: { ...approximate, radiusMeters: 0 },
      }),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      catalogue.savePhotoMetadataDraft(photo.photoId, 4, {
        publicLocation: { ...exact, point: { latitude: 0, longitude: NaN } },
      }),
      errorCode('invalid_input'),
    );
  });

  it('rejects cross-photo evidence and missing place snapshots atomically', async () => {
    const first = await catalogue.createPhoto();
    const second = await catalogue.createPhoto();
    const source = await sources.record(first.photoId, evidenceInput());
    await assert.rejects(
      catalogue.savePhotoMetadataDraft(second.photoId, 1, {
        sourceId: source.id,
      }),
    );
    await assert.rejects(
      catalogue.savePhotoMetadataDraft(second.photoId, 1, {
        publicLocation: {
          visibility: 'place',
          place: { placeId: 'missing-place', revision: 1 },
        },
      }),
    );
    assert.equal((await catalogue.getPhotoDraft(second.photoId)).revision, 1);
    assert.equal(await catalogue.getPhotoRevision(second.photoId, 2), null);
    assert.equal(
      await statement(
        'SELECT * FROM photo_metadata_states WHERE photo_id = ?',
        second.photoId,
      ).first(),
      null,
    );
  });

  it('rejects stale and competing metadata saves and unversioned SQL edits', async () => {
    const photo = await catalogue.createPhoto();
    const results = await Promise.allSettled([
      catalogue.savePhotoMetadataDraft(photo.photoId, 1, {
        title: 'Writer one',
      }),
      catalogue.savePhotoMetadataDraft(photo.photoId, 1, {
        title: 'Writer two',
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'conflict',
      ).length,
      1,
    );
    await assert.rejects(
      catalogue.savePhotoMetadataDraft(photo.photoId, 1, {}),
      errorCode('conflict'),
    );
    await assert.rejects(
      statement(
        'UPDATE photo_metadata_drafts SET title = ? WHERE photo_id = ?',
        'Mutation',
        photo.photoId,
      ).run(),
    );
    await assert.rejects(
      statement(
        'DELETE FROM photo_metadata_drafts WHERE photo_id = ?',
        photo.photoId,
      ).run(),
    );
    await assert.rejects(
      statement(
        `INSERT INTO photo_metadata_states SELECT photo_id, 1, source_id,
      title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url,
      capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason,
      private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters
      FROM photo_metadata_states WHERE photo_id = ? AND photo_revision = 2`,
        photo.photoId,
      ).run(),
    );
  });

  it('keeps same-named places distinct and round-trips aliases, provenance and antimeridian bounds', async () => {
    const countryA = await places.create({
      name: 'Country A',
      kind: 'country',
      provenance: { kind: 'manual' },
    });
    const countryB = await places.create({
      name: 'Country B',
      kind: 'country',
      provenance: { kind: 'manual' },
    });
    const first = await places.create({
      ...placeInput('Springfield', ref(countryA)),
      aliases: ['Example alias'],
      bounds: { south: -10, north: 10, west: 170, east: -170 },
      provenance: {
        kind: 'provider',
        source: 'synthetic-provider',
        providerId: 'test-place-1',
      },
    });
    const second = await places.create(
      placeInput('Springfield', ref(countryB)),
    );
    assert.notEqual(first.placeId, second.placeId);
    assert.deepEqual(await places.getRevision(ref(first)), first);
    assert.deepEqual(first.aliases, ['Example alias']);
    assert.equal(first.bounds.west, 170);
    assert.equal(first.bounds.east, -170);
    assert.deepEqual(
      (await places.ancestors(ref(first))).map((entry) => entry.placeId),
      [countryA.placeId],
    );
  });

  it('freezes selected places and ancestry while newer place drafts replace old versions', async () => {
    const parent = await places.create({
      name: 'Original region',
      kind: 'region',
      provenance: { kind: 'manual' },
    });
    const city = await places.create(placeInput('Original city', ref(parent)));
    const photo = await catalogue.createPhoto();
    await catalogue.savePhotoMetadataDraft(photo.photoId, 1, {
      publicLocation: { visibility: 'place', place: ref(city) },
    });
    await statement(
      'INSERT INTO published_photos VALUES (?, 2, 100)',
      photo.photoId,
    ).run();
    await places.saveDraft(parent.placeId, 1, {
      name: 'Draft region name',
      kind: 'region',
      provenance: { kind: 'manual' },
    });
    await places.saveDraft(
      city.placeId,
      1,
      placeInput('Draft city name', { placeId: parent.placeId, revision: 2 }),
    );
    assert.equal(await places.getRevision(ref(city)), null);
    assert.deepEqual(
      (await catalogue.getPublishedPhotoPlace(photo.photoId)).map(
        (p) => p.name,
      ),
      ['Original city', 'Original region'],
    );
    assert.deepEqual(
      (await catalogue.getPublishedPhotoMetadata(photo.photoId)).publicLocation
        .place,
      ref(city),
    );
  });

  it('rejects hierarchy cycles across revisions, self-parenting, orphan parents and excessive depth', async () => {
    const root = await places.create({
      name: 'Root area',
      kind: 'area',
      provenance: { kind: 'manual' },
    });
    const child = await places.create({
      name: 'Child area',
      kind: 'area',
      parent: ref(root),
      provenance: { kind: 'manual' },
    });
    await assert.rejects(
      places.saveDraft(root.placeId, 1, {
        name: root.name,
        kind: 'area',
        parent: ref(child),
        provenance: { kind: 'manual' },
      }),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      places.saveDraft(root.placeId, 1, {
        name: root.name,
        kind: 'area',
        parent: ref(root),
        provenance: { kind: 'manual' },
      }),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      places.create(
        placeInput('Orphan', { placeId: 'missing-place', revision: 1 }),
      ),
    );
    let parent = child;
    for (let depth = 3; depth <= 16; depth++)
      parent = await places.create({
        name: `Depth ${depth}`,
        kind: 'area',
        parent: ref(parent),
        provenance: { kind: 'manual' },
      });
    assert.equal((await places.ancestors(ref(parent))).length, 15);
    await assert.rejects(
      places.create({
        name: 'Depth 17',
        kind: 'area',
        parent: ref(parent),
        provenance: { kind: 'manual' },
      }),
      errorCode('invalid_input'),
    );
    assert.equal((await places.getDraft(root.placeId)).revision, 1);
  });

  it('rejects competing place edits and retains only the winning draft and aliases', async () => {
    const place = await places.create({
      ...placeInput('Concurrent place'),
      aliases: ['Old alias'],
    });
    const results = await Promise.allSettled([
      places.saveDraft(place.placeId, 1, {
        ...placeInput('Place writer one'),
        aliases: ['New alias one'],
      }),
      places.saveDraft(place.placeId, 1, {
        ...placeInput('Place writer two'),
        aliases: ['New alias two'],
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'conflict',
      ).length,
      1,
    );
    for (const sql of ['UPDATE place_drafts SET name = ? WHERE place_id = ?'])
      await assert.rejects(statement(sql, 'mutation', place.placeId).run());
    await assert.rejects(
      statement(
        'DELETE FROM place_drafts WHERE place_id = ?',
        place.placeId,
      ).run(),
    );
    await assert.rejects(
      statement(
        'INSERT INTO place_draft_aliases VALUES (?, 1, ?, ?)',
        place.placeId,
        'Late alias',
        'late alias',
      ).run(),
    );
    assert.equal(await places.getRevision(ref(place)), null);
    const winner = results.find((r) => r.status === 'fulfilled').value;
    assert.deepEqual(await places.getDraft(place.placeId), winner);
    assert.equal(
      (
        await statement(
          'SELECT COUNT(*) AS n FROM place_draft_aliases WHERE place_id=?',
          place.placeId,
        ).first()
      ).n,
      1,
    );
  });

  it('validates rights URLs, place types, bounds and required provenance', async () => {
    const photo = await catalogue.createPhoto();
    for (const rights of [
      { rightsUrl: 'javascript:alert(1)' },
      { publicContactUrl: 'data:text/plain,example' },
      { rightsUrl: 'https://user:password@example.test/' },
      { creators: Array(17).fill('Creator') },
    ])
      await assert.rejects(
        catalogue.savePhotoMetadataDraft(photo.photoId, 1, { rights }),
        errorCode('invalid_input'),
      );
    await assert.rejects(
      places.create({ ...placeInput(), kind: 'tag' }),
      errorCode('invalid_input'),
    );
    const site = await places.create({
      name: 'Parent site',
      kind: 'site',
      provenance: { kind: 'manual' },
    });
    await assert.rejects(
      places.create(placeInput('City under site', ref(site))),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      places.create({
        ...placeInput(),
        bounds: { south: 10, north: -10, west: 0, east: 0 },
      }),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      places.create({ ...placeInput(), provenance: { kind: 'provider' } }),
      errorCode('invalid_input'),
    );
    await assert.rejects(
      places.saveDraft('missing-place', 1, placeInput()),
      errorCode('not_found'),
    );
    assert.deepEqual(
      (await db.prepare('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });

  it('uses indexed public metadata and bounded parent lookup plans', async () => {
    const plans = [
      await statement(
        `EXPLAIN QUERY PLAN SELECT m.title FROM published_photos p JOIN photo_metadata_public m
        ON m.photo_id = p.photo_id AND m.photo_revision = p.photo_revision WHERE p.photo_id = ?`,
        'photo',
      ).all(),
      await statement(
        'EXPLAIN QUERY PLAN SELECT name FROM place_drafts WHERE place_id = ? AND revision = ?',
        'place',
        1,
      ).all(),
    ];
    for (const plan of plans) {
      const detail = plan.results.map((row) => row.detail).join(' ');
      assert.match(detail, /SEARCH .*USING INDEX/);
      assert.doesNotMatch(detail, /SCAN /);
    }
  });
});
