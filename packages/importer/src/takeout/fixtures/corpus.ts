/**
 * The Takeout fixture corpus (task 2.1, Requirements 1.1-1.7).
 *
 * One declarative manifest covering every documented way Takeout is lossy. `buildCorpus()`
 * materializes it into a caller-supplied directory; `corpus.test.ts` checks it against
 * itself; tasks 2.2-2.12 assert against it. Read `corpusTypes.ts` first — it explains why
 * every fixture carries an `expect` block and what the fields mean.
 *
 * ## How to read a fixture
 *
 * The filenames are the interesting part and they are written out literally, never derived by
 * a helper, because a helper that constructs `IMG_1234.jpg(1).json` from `IMG_1234(1).jpg`
 * encodes exactly the rule under test. Where a filename length matters — Takeout truncates
 * sidecar names to roughly 51 characters — the test asserts the length rather than trusting
 * the comment.
 *
 * Two conventions run through the whole corpus:
 *
 * - **mtime is deliberately wrong.** Every fixture but one has an mtime of
 *   {@link DOWNLOAD_MTIME}, the moment the archive was unpacked, which is what Takeout
 *   actually leaves behind. So a fixture whose expected provenance is the sidecar or EXIF is
 *   only satisfiable by reading the sidecar or the EXIF, and the single fixture that legitimately
 *   falls back to mtime is unmistakable.
 * - **`(n)` disambiguation is adversarial.** `IMG_1234.jpg` and `IMG_1234(1).jpg` sit in the
 *   same folder with both of their sidecars, so a resolver that pairs by loose prefix matching
 *   steals one file's metadata for the other and the corpus catches it.
 *
 * ## Coverage
 *
 * | Shape | Fixture |
 * |---|---|
 * | Exact `.json` sidecar | `exact-sidecar` |
 * | `.supplemental-metadata.json` sidecar | `live-photo-still`, `bearbeitet-base`, `bearbeitet-variant` |
 * | Truncated sidecar filename (~51 chars) | `truncated-sidecar` |
 * | `(n)` in both positions | `disambiguator-swap` |
 * | Unique-basename fallback | `unique-basename` |
 * | `-edited` plus three localized suffixes | `edited-variant`, `bearbeitet-variant`, `modifie-variant`, `editado-variant` |
 * | HEIC + MOV Live Photo | `live-photo-still`, `live-photo-motion` |
 * | Album folder with `metadata.json` | `Iceland 2019`, `Familienurlaub 2020` |
 * | `Photos from YYYY` bucket | `Photos from 2019`, `Photos from 2021` |
 * | `Archive/` | `archived-photo` |
 * | `Trash/` | `trashed-photo` |
 * | Unpaired media | `unpaired-video`, `edited-variant`, `modifie-variant`, `editado-variant` |
 * | EXIF disagreeing with the sidecar | `exact-sidecar` |
 * | Multi-part export, sidecar in another part | `cross-part-sidecar` |
 */

import { AssetKind, CapturedAtSource } from '@photo-archive/core';

import { FolderRole, PairingStep } from './corpusTypes.ts';
import type { MediaFixture, TakeoutCorpus } from './corpusTypes.ts';

/**
 * Where the media lives inside each expanded part. Google's zips all expand to a `Takeout`
 * directory containing one folder per exported product, so this prefix repeats in every part
 * and is what a traversal has to look through to find the export it was pointed at.
 */
export const TAKEOUT_MEDIA_ROOT = 'Takeout/Google Photos';

/** Part directory names, in the order Google numbers them. */
export const PART_001 = 'takeout-20240115T101530Z-001';
export const PART_002 = 'takeout-20240115T101530Z-002';
export const PART_003 = 'takeout-20240115T101530Z-003';

/**
 * The mtime every file gets unless it is the fixture that tests the mtime fallback: the
 * moment the archive was unpacked, which bears no relation to when anything was taken.
 */
export const DOWNLOAD_MTIME = '2024-01-15T10:15:30Z';

/** Rendered as `metadata.json`, and the reason two of these folders are albums. */
const ICELAND_TITLE = 'Iceland 2019';
const FAMILIENURLAUB_TITLE = 'Familienurlaub 2020';

export const TAKEOUT_CORPUS: TakeoutCorpus = {
  parts: [
    {
      name: PART_001,
      note: 'Photos from 2019 and the Iceland 2019 album, including the Live Photo pair.',
    },
    {
      name: PART_002,
      note: 'Familienurlaub 2020, the first half of Photos from 2021, Archive, and the sidecar belonging to a photo that lands in part 003.',
    },
    {
      name: PART_003,
      note: 'The rest of Photos from 2021 and Trash. Not independently importable: one of its photos has no sidecar without part 002.',
    },
  ],

  folders: [
    {
      dir: 'Photos from 2019',
      parts: [PART_001],
      role: FolderRole.YearBucket,
      expect: {
        isAlbum: false,
        albumTitle: null,
        yearBucket: 2019,
        note: 'A chronological bucket and never an album, which is why it has no metadata.json.',
      },
    },
    {
      dir: ICELAND_TITLE,
      parts: [PART_001],
      role: FolderRole.Album,
      metadata: {
        title: ICELAND_TITLE,
        description: 'Ring road, August 2019',
        albumDate: '2019-08-14T00:00:00Z',
        geo: { latitude: 64.9631, longitude: -19.0208, altitude: 0 },
      },
      expect: {
        isAlbum: true,
        albumTitle: ICELAND_TITLE,
        yearBucket: null,
        note: "The album date is the album's own, unrelated to any member's capture time.",
      },
    },
    {
      dir: FAMILIENURLAUB_TITLE,
      parts: [PART_002],
      role: FolderRole.Album,
      metadata: {
        title: FAMILIENURLAUB_TITLE,
        description: '',
        albumDate: '2020-07-21T00:00:00Z',
      },
      expect: {
        isAlbum: true,
        albumTitle: FAMILIENURLAUB_TITLE,
        yearBucket: null,
        note: 'Title comes from metadata.json, not from the folder name, even where they match.',
      },
    },
    {
      dir: 'Photos from 2021',
      parts: [PART_002, PART_003],
      role: FolderRole.YearBucket,
      expect: {
        isAlbum: false,
        albumTitle: null,
        yearBucket: 2021,
        note: 'Split across two parts. Pairing cannot run per-part: one member of this folder has its media in 003 and its sidecar in 002.',
      },
    },
    {
      dir: 'Archive',
      parts: [PART_002],
      role: FolderRole.Archive,
      expect: {
        isAlbum: false,
        albumTitle: null,
        yearBucket: null,
        note: 'Imported and flagged archived. Not an album despite being a named folder, and it carries no metadata.json.',
      },
    },
    {
      dir: 'Trash',
      parts: [PART_003],
      role: FolderRole.Trash,
      expect: {
        isAlbum: false,
        albumTitle: null,
        yearBucket: null,
        note: 'Importing Trash at all is opt-in; when imported, contents are flagged.',
      },
    },
  ],

  media: [
    // ---- Photos from 2019: exact pairing, the (n) trap, and truncation ----
    {
      id: 'exact-sidecar',
      part: PART_001,
      folder: 'Photos from 2019',
      file: 'IMG_1234.jpg',
      mtime: DOWNLOAD_MTIME,
      // A week earlier than the sidecar, and wrong. Takeout rewrote it.
      exif: { dateTimeOriginal: '2019:06:01 08:00:00' },
      sidecar: {
        file: 'IMG_1234.jpg.json',
        title: 'IMG_1234.jpg',
        photoTakenAt: '2019-06-08T14:22:31Z',
        creationAt: '2019-06-09T02:11:00Z',
        geo: { latitude: 52.520008, longitude: 13.404954, altitude: 34 },
        favorited: true,
      },
      expect: {
        sidecarFile: 'IMG_1234.jpg.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2019-06-08T14:22:31Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'The EXIF-versus-sidecar case: all three sources disagree and the sidecar wins (Requirement 1.2). Reading EXIF here yields 2019-06-01, reading mtime yields 2024-01-15, and both are wrong.',
      },
    },
    {
      id: 'disambiguator-swap',
      part: PART_001,
      folder: 'Photos from 2019',
      file: 'IMG_1234(1).jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        // The `(n)` moves to the end of the sidecar name, after the media extension.
        file: 'IMG_1234.jpg(1).json',
        title: 'IMG_1234.jpg',
        photoTakenAt: '2019-06-08T14:22:35Z',
        creationAt: '2019-06-09T02:11:04Z',
      },
      expect: {
        sidecarFile: 'IMG_1234.jpg(1).json',
        pairingStep: PairingStep.DisambiguatorSwap,
        capturedAt: '2019-06-08T14:22:35Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Sits beside `exact-sidecar` on purpose. A resolver that matches loosely pairs this file with IMG_1234.jpg.json and silently backdates it by four seconds — a difference small enough to survive review and large enough to be wrong.',
      },
    },
    {
      id: 'truncated-sidecar',
      part: PART_001,
      folder: 'Photos from 2019',
      // 53 characters, which is past the limit Takeout applies to the sidecar name.
      file: '2019-06-08_family_reunion_backyard_barbecue_photo.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        // 51 characters including `.json`: the media name cut mid-word, extension and all.
        file: '2019-06-08_family_reunion_backyard_barbecue_ph.json',
        title: '2019-06-08_family_reunion_backyard_barbecue_photo.jpg',
        photoTakenAt: '2019-06-08T15:05:09Z',
        creationAt: '2019-06-09T02:12:00Z',
      },
      expect: {
        sidecarFile: '2019-06-08_family_reunion_backyard_barbecue_ph.json',
        pairingStep: PairingStep.Truncated,
        capturedAt: '2019-06-08T15:05:09Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'The sidecar stem is a prefix of the media filename but is not a valid filename itself — the `.jpg` is cut in half. Only the untruncated `title` field inside the JSON names the media in full.',
      },
    },

    // ---- Iceland 2019 album: Live Photo pair and an -edited variant ----
    {
      id: 'live-photo-still',
      part: PART_001,
      folder: ICELAND_TITLE,
      file: 'IMG_2001.HEIC',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_2001.HEIC.supplemental-metadata.json',
        title: 'IMG_2001.HEIC',
        photoTakenAt: '2019-08-14T09:15:00Z',
        creationAt: '2019-08-14T19:40:00Z',
        geo: { latitude: 63.6314, longitude: -19.628, altitude: 61 },
        people: ['Anna'],
      },
      expect: {
        sidecarFile: 'IMG_2001.HEIC.supplemental-metadata.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2019-08-14T09:15:00Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: 'live-photo-motion',
        albums: [ICELAND_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'The still half of the Live Photo, and the half the timeline shows. `.supplemental-metadata.json` is still exact pairing — it is the second probe of step 1, not a fallback.',
      },
    },
    {
      id: 'live-photo-motion',
      part: PART_001,
      folder: ICELAND_TITLE,
      file: 'IMG_2001.MOV',
      mtime: DOWNLOAD_MTIME,
      expect: {
        // Google emits one sidecar for the pair, named after the still. The MOV reaches it
        // through step 4: no exact, truncated, or disambiguator probe matches, and
        // `IMG_2001` is a unique basename in this folder.
        sidecarFile: 'IMG_2001.HEIC.supplemental-metadata.json',
        pairingStep: PairingStep.UniqueBasename,
        capturedAt: '2019-08-14T09:15:00Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.MotionComponent,
        variantOf: null,
        livePairOf: 'live-photo-still',
        albums: [ICELAND_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: true,
        note: "Sharing the still's sidecar is the point of step 4 and it is the right outcome: the motion component gets the real capture time, so it sorts with its still instead of landing in 2024 on mtime. It is a real asset with its own hash and bytes, hidden from the timeline rather than dropped.",
      },
    },
    {
      id: 'edited-base',
      part: PART_001,
      folder: ICELAND_TITLE,
      file: 'IMG_2002.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_2002.jpg.json',
        title: 'IMG_2002.jpg',
        photoTakenAt: '2019-08-14T11:02:44Z',
        creationAt: '2019-08-14T19:41:00Z',
      },
      expect: {
        sidecarFile: 'IMG_2002.jpg.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2019-08-14T11:02:44Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [ICELAND_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Base of `edited-variant`. A base is never itself a variant.',
      },
    },
    {
      id: 'edited-variant',
      part: PART_001,
      folder: ICELAND_TITLE,
      file: 'IMG_2002-edited.jpg',
      mtime: DOWNLOAD_MTIME,
      // Google's edited render keeps DateTimeOriginal, which is the only reason this file
      // does not fall all the way back to mtime.
      exif: { dateTimeOriginal: '2019:08:14 11:02:44' },
      expect: {
        sidecarFile: null,
        pairingStep: null,
        capturedAt: '2019-08-14T11:02:44Z',
        capturedAtSource: CapturedAtSource.Exif,
        kind: AssetKind.Image,
        variantOf: 'edited-base',
        livePairOf: null,
        albums: [ICELAND_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Unpaired, and must stay unpaired: `IMG_2002.jpg.json` is neither a prefix of this filename nor a basename match, so nothing but a sloppy resolver would attach it. Provenance comes from its own EXIF, which happens to agree with the base — the variant link comes from the filename suffix, not from the timestamps matching.',
      },
    },

    // ---- Familienurlaub 2020: localized -edited suffixes ----
    {
      id: 'bearbeitet-base',
      part: PART_002,
      folder: FAMILIENURLAUB_TITLE,
      file: 'IMG_3001.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_3001.jpg.supplemental-metadata.json',
        title: 'IMG_3001.jpg',
        photoTakenAt: '2020-07-21T16:40:12Z',
        creationAt: '2020-07-21T20:00:00Z',
      },
      expect: {
        sidecarFile: 'IMG_3001.jpg.supplemental-metadata.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2020-07-21T16:40:12Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [FAMILIENURLAUB_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
      },
    },
    {
      id: 'bearbeitet-variant',
      part: PART_002,
      folder: FAMILIENURLAUB_TITLE,
      file: 'IMG_3001-bearbeitet.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_3001-bearbeitet.jpg.supplemental-metadata.json',
        title: 'IMG_3001-bearbeitet.jpg',
        photoTakenAt: '2020-07-21T16:40:12Z',
        creationAt: '2020-07-21T20:05:00Z',
      },
      expect: {
        sidecarFile: 'IMG_3001-bearbeitet.jpg.supplemental-metadata.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2020-07-21T16:40:12Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: 'bearbeitet-base',
        livePairOf: null,
        albums: [FAMILIENURLAUB_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'A variant that does have its own sidecar, so variant linking cannot be implemented as "the file with no sidecar". Its 50-character sidecar name is just inside the truncation limit, which is why it survived intact.',
      },
    },
    {
      id: 'localized-base',
      part: PART_002,
      folder: FAMILIENURLAUB_TITLE,
      file: 'IMG_3002.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_3002.jpg.json',
        title: 'IMG_3002.jpg',
        photoTakenAt: '2020-07-22T10:11:12Z',
        creationAt: '2020-07-22T18:00:00Z',
      },
      expect: {
        sidecarFile: 'IMG_3002.jpg.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2020-07-22T10:11:12Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [FAMILIENURLAUB_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: "Base of both `modifie-variant` and `editado-variant`. One export rarely mixes locales; the remaining suffixes from the design's table are gathered on this one base rather than costing three more base assets.",
      },
    },
    {
      id: 'modifie-variant',
      part: PART_002,
      folder: FAMILIENURLAUB_TITLE,
      file: 'IMG_3002-modifié.jpg',
      mtime: DOWNLOAD_MTIME,
      exif: { dateTimeOriginal: '2020:07:22 10:11:12' },
      expect: {
        sidecarFile: null,
        pairingStep: null,
        capturedAt: '2020-07-22T10:11:12Z',
        capturedAtSource: CapturedAtSource.Exif,
        kind: AssetKind.Image,
        variantOf: 'localized-base',
        livePairOf: null,
        albums: [FAMILIENURLAUB_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'The `é` is not decoration: this filename has two Unicode normalizations, macOS and Linux disagree about which one a directory listing returns, and a suffix table matched against the wrong form silently stops recognizing the variant.',
      },
    },
    {
      id: 'editado-variant',
      part: PART_002,
      folder: FAMILIENURLAUB_TITLE,
      file: 'IMG_3002-editado.jpg',
      mtime: DOWNLOAD_MTIME,
      exif: { dateTimeOriginal: '2020:07:22 10:11:12' },
      expect: {
        sidecarFile: null,
        pairingStep: null,
        capturedAt: '2020-07-22T10:11:12Z',
        capturedAtSource: CapturedAtSource.Exif,
        kind: AssetKind.Image,
        variantOf: 'localized-base',
        livePairOf: null,
        albums: [FAMILIENURLAUB_TITLE],
        folderRole: FolderRole.Album,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
      },
    },

    // ---- Photos from 2021: step-4 fallback, unpaired media, split parts ----
    {
      id: 'unique-basename',
      part: PART_002,
      folder: 'Photos from 2021',
      // Uppercase extension; the sidecar spells it lowercase.
      file: 'IMG_0042.JPG',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_0042.jpg.json',
        title: 'IMG_0042.JPG',
        photoTakenAt: '2021-05-02T18:30:00Z',
        creationAt: '2021-05-02T22:00:00Z',
      },
      expect: {
        sidecarFile: 'IMG_0042.jpg.json',
        pairingStep: PairingStep.UniqueBasename,
        capturedAt: '2021-05-02T18:30:00Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Every earlier step fails on a case difference alone: `IMG_0042.jpg` is not a prefix of `IMG_0042.JPG`, and there is no `(n)` to swap. Only the basename before the extension matches, and it matches uniquely in this folder.',
      },
    },
    {
      id: 'unpaired-video',
      part: PART_002,
      folder: 'Photos from 2021',
      file: 'VID_20210704_121314.mp4',
      // The one fixture whose mtime is meaningful, because nothing else is available.
      mtime: '2021-07-04T12:13:14Z',
      expect: {
        sidecarFile: null,
        pairingStep: null,
        capturedAt: '2021-07-04T12:13:14Z',
        capturedAtSource: CapturedAtSource.FileMtime,
        kind: AssetKind.Video,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'No sidecar and no EXIF: imported with degraded provenance and reported, never dropped (Requirement 1.10). Not a Live Photo — no still shares its stem.',
      },
    },
    {
      id: 'cross-part-sidecar',
      part: PART_003,
      folder: 'Photos from 2021',
      file: 'IMG_7777.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_7777.jpg.json',
        // Takeout split on size, so the bytes and their metadata ended up in different zips.
        part: PART_002,
        title: 'IMG_7777.jpg',
        photoTakenAt: '2021-09-09T07:07:07Z',
        creationAt: '2021-09-09T12:00:00Z',
      },
      expect: {
        sidecarFile: 'IMG_7777.jpg.json',
        pairingStep: PairingStep.Exact,
        sidecarInOtherPart: true,
        capturedAt: '2021-09-09T07:07:07Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.YearBucket,
        archived: false,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Pairing is exact — but only once the parts are one logical export (Requirement 1.1). Import part 003 alone and this photo is unpaired with a 2024 timestamp; the failure looks like a pairing bug and is a traversal bug.',
      },
    },

    // ---- Archive and Trash ----
    {
      id: 'archived-photo',
      part: PART_002,
      folder: 'Archive',
      file: 'IMG_5001.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_5001.jpg.json',
        title: 'IMG_5001.jpg',
        photoTakenAt: '2018-03-03T03:03:03Z',
        creationAt: '2018-03-04T09:00:00Z',
        archived: true,
      },
      expect: {
        sidecarFile: 'IMG_5001.jpg.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2018-03-03T03:03:03Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.Archive,
        archived: true,
        inTrash: false,
        excludedFromTimeline: false,
        note: 'Archived, so flagged rather than skipped, and the folder is not an album.',
      },
    },
    {
      id: 'trashed-photo',
      part: PART_003,
      folder: 'Trash',
      file: 'IMG_8001.jpg',
      mtime: DOWNLOAD_MTIME,
      sidecar: {
        file: 'IMG_8001.jpg.json',
        title: 'IMG_8001.jpg',
        photoTakenAt: '2021-11-11T11:11:11Z',
        creationAt: '2021-11-11T18:00:00Z',
        inTrash: true,
      },
      expect: {
        sidecarFile: 'IMG_8001.jpg.json',
        pairingStep: PairingStep.Exact,
        capturedAt: '2021-11-11T11:11:11Z',
        capturedAtSource: CapturedAtSource.TakeoutJson,
        kind: AssetKind.Image,
        variantOf: null,
        livePairOf: null,
        albums: [],
        folderRole: FolderRole.Trash,
        archived: false,
        inTrash: true,
        excludedFromTimeline: false,
        note: 'Trash is opt-in, so this fixture is what a run that opted out has to leave alone and a run that opted in has to flag.',
      },
    },
  ],
};

/** Fixture ids, for tests that want to look one up without scanning. */
export const FIXTURE_IDS: readonly string[] = TAKEOUT_CORPUS.media.map((fixture) => fixture.id);

/** The fixture with this id, or `undefined`. */
export function fixtureById(id: string): MediaFixture | undefined {
  return TAKEOUT_CORPUS.media.find((fixture) => fixture.id === id);
}
