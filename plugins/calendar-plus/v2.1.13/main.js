'use strict';

var obsidian = require('obsidian');

const VIEW_TYPE_CALENDAR = "calendar-plus-view";
const TRIGGER_ON_OPEN = "calendar-plus:open";
const DEFAULT_DAILY_NOTE_FORMAT = "YYYY-MM-DD";
const DEFAULT_WEEKLY_NOTE_FORMAT = "gggg-[W]ww";
const DEFAULT_MONTHLY_NOTE_FORMAT = "YYYY-MM";
const DEFAULT_QUARTERLY_NOTE_FORMAT = "YYYY-[Q]Q";
const DEFAULT_YEARLY_NOTE_FORMAT = "YYYY";

// Persistent, downscaled-thumbnail cache for featured images.
//
// Why this exists: featured images are full-resolution photos used as ~40px cell
// backgrounds. Decoding the full image on every render (especially a month of
// them when the sidebar opens) is expensive and memory-heavy. Instead we
// generate a small thumbnail once, store it as a file in the plugin's folder
// (`.obsidian/plugins/calendar-plus/thumbnail-cache/`), and render that. After
// the first generation, every render reads a tiny image — cheap on any device.
//
// Design notes:
// - Persistent (plugin-folder files) so the thumbnail is generated once *ever*
//   per device, not once per session — important on low-spec phones, where
//   re-decoding full-res images every launch would be a battery/CPU cost.
// - Non-blocking: `getThumbnailUrl` never decodes synchronously. It returns a
//   ready URL or null; on a miss it kicks off background preparation and fires
//   the (debounced) ready callback when done, which the view turns into a tick
//   so the cell re-resolves and the image pops in.
// - Generation is bounded-concurrency so a cold month (~30 images) doesn't
//   decode everything at once.
// - The day↔image association is NOT stored here — that's always derived live
//   from the note. This cache only maps an image file (path + mtime) to its
//   downscaled thumbnail, and is fully regenerable/disposable.
const MAX_DIM = 128; // longest thumbnail edge in px (cells are ~40px; this is retina-safe)
const JPEG_QUALITY = 0.72;
const MAX_CONCURRENT_GENERATIONS = 3;
let app = null;
let cacheDir = null;
let dirReady = null;
// key -> object URL of the ready thumbnail (or a full-res fallback on failure).
const urlByKey = new Map();
// key -> in-progress preparation, so concurrent requests share one job.
const inFlight$1 = new Map();
// Ready callbacks (one per open calendar view). A Set rather than a single
// slot so multiple views — e.g. a calendar dragged into a popout window — all
// refresh when a thumbnail lands, and a closed view's callback is removed
// rather than lingering and pointing at a torn-down calendar.
const readyCallbacks = new Set();
// Coalesce a burst of "thumbnail ready" events (e.g. a cold month) into one
// refresh so the calendar re-renders once rather than per image.
const fireReady = obsidian.debounce(() => {
    for (const cb of readyCallbacks)
        cb();
}, 50, true);
let activeGenerations = 0;
const generationQueue = [];
// Bumped whenever cached state is invalidated (teardown, source removal, GC
// sweep). An in-flight prepare() captures the epoch at start and discards its
// result if the epoch changed while it ran, so a job that finishes *after* a
// teardown/remove can't repopulate a just-cleared map with an object URL that
// nothing will ever revoke.
let epoch = 0;
function initThumbnailCache(a, dir) {
    app = a;
    cacheDir = obsidian.normalizePath(dir);
    dirReady = null;
}
/**
 * Register a callback fired (debounced) when a thumbnail becomes ready. Returns
 * an unregister function — each calendar view registers its own tick on open
 * and drops it on close.
 */
function registerThumbnailReadyCallback(cb) {
    readyCallbacks.add(cb);
    return () => readyCallbacks.delete(cb);
}
/** Revoke object URLs and reset. Called on plugin unload. */
function teardownThumbnailCache() {
    epoch++;
    for (const url of urlByKey.values()) {
        if (url.startsWith("blob:"))
            URL.revokeObjectURL(url);
    }
    urlByKey.clear();
    inFlight$1.clear();
    readyCallbacks.clear();
    app = null;
    cacheDir = null;
    dirReady = null;
}
/** True when the cache is initialized and able to persist thumbnails. */
function isThumbnailCacheAvailable() {
    return app !== null && cacheDir !== null;
}
/**
 * Remove all cached thumbnails for a given source image path (any mtime), in
 * memory and on disk. Call this when the source image is deleted or renamed so
 * its thumbnail doesn't orphan in the cache folder. Best-effort.
 */
async function removeThumbnailsForSource(sourcePath) {
    const a = app;
    const dir = cacheDir;
    if (!a || !dir)
        return;
    epoch++;
    const prefix = `${hashPath(sourcePath)}-`;
    for (const key of [...urlByKey.keys()]) {
        if (key.startsWith(prefix)) {
            const url = urlByKey.get(key);
            if (url === null || url === void 0 ? void 0 : url.startsWith("blob:"))
                URL.revokeObjectURL(url);
            urlByKey.delete(key);
        }
    }
    try {
        const listing = await a.vault.adapter.list(dir);
        for (const full of listing.files) {
            const name = full.substring(full.lastIndexOf("/") + 1);
            if (name.startsWith(prefix))
                await a.vault.adapter.remove(full);
        }
    }
    catch (_a) {
        // best-effort
    }
}
/**
 * The display URL for an image file's thumbnail.
 * - Returns the ready thumbnail (or a cached full-res fallback) when available.
 * - Returns null while a thumbnail is still being prepared — callers should
 *   show no image yet; the ready callback will fire a refresh when it lands.
 * Never decodes synchronously.
 */
function getThumbnailUrl(file) {
    const a = app;
    const dir = cacheDir;
    if (!a || !dir)
        return null;
    const key = keyFor(file);
    const ready = urlByKey.get(key);
    if (ready)
        return ready;
    if (!inFlight$1.has(key)) {
        const job = prepare(a, dir, file, key).finally(() => inFlight$1.delete(key));
        inFlight$1.set(key, job);
    }
    return null;
}
function hashPath(path) {
    // djb2 variant, hex/base36-encoded. Collision risk is negligible for a
    // personal vault, and a collision would only mis-thumbnail one cell.
    let h = 5381;
    for (let i = 0; i < path.length; i++) {
        h = (Math.imul(h, 33) ^ path.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}
function keyFor(file) {
    return `${hashPath(file.path)}-${file.stat.mtime}`;
}
async function prepare(a, dir, file, key) {
    const startEpoch = epoch;
    let url = null;
    try {
        url = await loadFromDisk(a, dir, key);
        if (!url)
            url = await generateAndStore(a, dir, file, key);
    }
    catch (_a) {
        url = null;
    }
    if (!url) {
        // Couldn't make a thumbnail (e.g. SVG, decode failure) — fall back to the
        // full-resolution image so the cell still shows something.
        try {
            url = a.vault.getResourcePath(file);
        }
        catch (_b) {
            url = null;
        }
    }
    if (!url)
        return;
    if (epoch !== startEpoch) {
        // Cache was torn down / invalidated while we ran — don't repopulate the
        // cleared map, and revoke the blob we just made so it doesn't leak.
        if (url.startsWith("blob:"))
            URL.revokeObjectURL(url);
        return;
    }
    // Drop any older-mtime object URLs for this same source image before storing
    // the new one (the on-disk equivalent is pruneStaleSiblings).
    revokeSiblingUrls(file.path, key);
    urlByKey.set(key, url);
    fireReady();
}
// Revoke + drop any urlByKey entries for the same source image at a different
// (older) key/mtime, so re-saving an image within a session doesn't accumulate
// orphaned blob URLs that nothing revokes until unload.
function revokeSiblingUrls(sourcePath, keepKey) {
    const prefix = `${hashPath(sourcePath)}-`;
    for (const k of [...urlByKey.keys()]) {
        if (k !== keepKey && k.startsWith(prefix)) {
            const u = urlByKey.get(k);
            if (u === null || u === void 0 ? void 0 : u.startsWith("blob:"))
                URL.revokeObjectURL(u);
            urlByKey.delete(k);
        }
    }
}
/**
 * Garbage-collect: keep only thumbnails for the given in-use source images (at
 * their current mtime) and delete every other cached thumbnail, in memory and
 * on disk. Used to drop thumbnails for images that are no longer any note's
 * featured image (e.g. a banner the user swapped out) even though the image
 * still exists in the vault. Best-effort.
 */
async function pruneThumbnailsExcept(inUseFiles) {
    const a = app;
    const dir = cacheDir;
    if (!a || !dir)
        return;
    epoch++;
    const keep = new Set(inUseFiles.map(keyFor));
    for (const key of [...urlByKey.keys()]) {
        if (!keep.has(key)) {
            const url = urlByKey.get(key);
            if (url === null || url === void 0 ? void 0 : url.startsWith("blob:"))
                URL.revokeObjectURL(url);
            urlByKey.delete(key);
        }
    }
    try {
        const listing = await a.vault.adapter.list(dir);
        for (const full of listing.files) {
            const name = full.substring(full.lastIndexOf("/") + 1);
            if (!name.endsWith(".jpg"))
                continue;
            if (!keep.has(name.slice(0, -4)))
                await a.vault.adapter.remove(full);
        }
    }
    catch (_a) {
        // best-effort
    }
}
async function ensureDir(a, dir) {
    if (!dirReady) {
        dirReady = (async () => {
            try {
                if (!(await a.vault.adapter.exists(dir))) {
                    await a.vault.adapter.mkdir(dir);
                }
            }
            catch (e) {
                // Don't cache the failure forever — reset so the next generation retries
                // instead of every future thumbnail silently falling back to full-res.
                dirReady = null;
                throw e;
            }
        })();
    }
    return dirReady;
}
async function loadFromDisk(a, dir, key) {
    const path = `${dir}/${key}.jpg`;
    if (!(await a.vault.adapter.exists(path)))
        return null;
    const bytes = await a.vault.adapter.readBinary(path);
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
async function generateAndStore(a, dir, file, key) {
    // Read + decode inside the concurrency gate. The full-resolution source bytes
    // are large; reading them *before* acquiring a slot would let a cold month
    // (~30 images, all requested in one tick) hold ~30 full-res buffers in memory
    // at once, even though only MAX_CONCURRENT_GENERATIONS decode at a time. Gating
    // the read too caps peak source-byte memory at the concurrency limit — the
    // win that matters on low-spec/mobile.
    await acquireGenerationSlot();
    let thumbBytes;
    try {
        const srcBytes = await a.vault.readBinary(file);
        thumbBytes = await generateThumbnail(srcBytes);
    }
    finally {
        releaseGenerationSlot();
    }
    if (!thumbBytes)
        return null;
    await ensureDir(a, dir);
    await a.vault.adapter.writeBinary(`${dir}/${key}.jpg`, thumbBytes);
    void pruneStaleSiblings(a, dir, file, key);
    return URL.createObjectURL(new Blob([thumbBytes], { type: "image/jpeg" }));
}
async function generateThumbnail(srcBytes) {
    let bitmap = null;
    try {
        // No resize options passed: those aren't supported on all mobile webviews,
        // so decode then scale on draw (the full decode is the unavoidable one-time
        // cost; the stored thumbnail is tiny).
        bitmap = await createImageBitmap(new Blob([srcBytes]));
        const longest = Math.max(bitmap.width, bitmap.height);
        const scale = longest > MAX_DIM ? MAX_DIM / longest : 1;
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        // `activeDocument` (not `document`) for popout-window compatibility, per
        // the Obsidian plugin checker. The canvas is off-DOM (never attached), so
        // this is a checker-hygiene change rather than a functional one.
        const canvas = activeDocument.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return null;
        ctx.drawImage(bitmap, 0, 0, w, h);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
        return blob ? await blob.arrayBuffer() : null;
    }
    catch (_a) {
        return null;
    }
    finally {
        bitmap === null || bitmap === void 0 ? void 0 : bitmap.close();
    }
}
// Remove thumbnails for the same source image at older mtimes (i.e. the image
// was edited). Best-effort; runs only on (re)generation, not in steady state.
async function pruneStaleSiblings(a, dir, file, currentKey) {
    try {
        const prefix = `${hashPath(file.path)}-`;
        const current = `${currentKey}.jpg`;
        const listing = await a.vault.adapter.list(dir);
        for (const full of listing.files) {
            const name = full.substring(full.lastIndexOf("/") + 1);
            if (name.startsWith(prefix) && name !== current) {
                await a.vault.adapter.remove(full);
            }
        }
    }
    catch (_a) {
        // best-effort
    }
}
function acquireGenerationSlot() {
    if (activeGenerations < MAX_CONCURRENT_GENERATIONS) {
        activeGenerations++;
        return Promise.resolve();
    }
    return new Promise((resolve) => generationQueue.push(resolve));
}
function releaseGenerationSlot() {
    const next = generationQueue.shift();
    if (next) {
        next(); // hand the slot to the next waiter (activeGenerations stays the same)
    }
    else {
        activeGenerations--;
    }
}

/**
 * Runtime moment value — the bundled instance Obsidian provides, retyped via
 * `MomentFactory`. The cast is type-only; the underlying value is unchanged.
 */
const moment = obsidian.moment;

const PERIODICITY_TO_UNIT = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    quarterly: "quarter",
    yearly: "year",
};
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function joinPath(...partSegments) {
    let parts = [];
    for (const seg of partSegments) {
        parts = parts.concat(seg.split("/"));
    }
    const newParts = [];
    for (const part of parts) {
        if (!part || part === ".")
            continue;
        newParts.push(part);
    }
    // Preserve a leading slash if the first segment started with one.
    if (parts[0] === "")
        newParts.unshift("");
    return newParts.join("/");
}
/**
 * Pure path generation: format the filename, join with the configured folder,
 * and normalize. Does not touch the vault and does not create folders.
 *
 * Safe to call from lookup/detection code. Note creation must additionally
 * call `ensureParentFolderExists(path)` before writing.
 */
function getPeriodicNotePath(settings, date) {
    let filename = date.format(settings.format);
    if (!filename.endsWith(".md"))
        filename += ".md";
    const directory = settings.folder || "";
    return obsidian.normalizePath(joinPath(directory, filename));
}
/**
 * Given a file path, walk the parent folder chain from the root downward and
 * create any missing ancestor folders. For `Notes/Periodic/Daily/2026-05-03.md`
 * this ensures `Notes`, then `Notes/Periodic`, then `Notes/Periodic/Daily`
 * exist, creating only the ones that don't already.
 *
 * Intended to be called by note-creation code immediately before
 * `vault.create(path, ...)`.
 */
async function ensureParentFolderExists(path) {
    const segments = path.replace(/\\/g, "/").split("/");
    segments.pop(); // drop the basename — we only care about the parent chain
    if (segments.length === 0)
        return;
    const { vault } = window.app;
    const accumulated = [];
    for (const segment of segments) {
        accumulated.push(segment);
        const ancestor = joinPath(...accumulated);
        // Skip empty results from a leading "/" or a stray empty segment.
        if (!ancestor)
            continue;
        const normalized = obsidian.normalizePath(ancestor);
        if (!vault.getAbstractFileByPath(normalized)) {
            await vault.createFolder(normalized);
        }
    }
}
async function getTemplateInfo(template) {
    var _a, _b;
    if (!template || template.trim() === "") {
        return { contents: "", foldInfo: null };
    }
    const templatePath = obsidian.normalizePath(template);
    if (templatePath === "/") {
        return { contents: "", foldInfo: null };
    }
    const { metadataCache, vault } = window.app;
    try {
        const templateFile = metadataCache.getFirstLinkpathDest(templatePath, "");
        if (!templateFile) {
            console.warn(`[Calendar] Template file not found: '${templatePath}'`);
            return { contents: "", foldInfo: null };
        }
        const contents = await vault.cachedRead(templateFile);
        const foldInfo = (_b = (_a = window.app.foldManager) === null || _a === void 0 ? void 0 : _a.load(templateFile)) !== null && _b !== void 0 ? _b : null;
        return { contents, foldInfo };
    }
    catch (err) {
        console.error(`[Calendar] Failed to read the periodic note template '${templatePath}'`, err);
        new obsidian.Notice("Failed to read the periodic note template");
        return { contents: "", foldInfo: null };
    }
}
const PARAMETERIZED_DATE_TIME_RE = /{{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?}}/gi;
const WEEKDAY_TOKEN_RE = /{{\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:(.*?)}}/gi;
const DAYS_OF_WEEK_BASE = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
function getDaysOfWeek$1() {
    const weekStart = moment.localeData()
        ._week.dow;
    return [
        ...DAYS_OF_WEEK_BASE.slice(weekStart),
        ...DAYS_OF_WEEK_BASE.slice(0, weekStart),
    ];
}
function getDayOfWeekNumericalValue(dayOfWeekName) {
    return getDaysOfWeek$1().indexOf(dayOfWeekName.toLowerCase());
}
function applyTemplateTokens(contents, periodicity, date, format) {
    const filename = date.format(format);
    let result = contents;
    // Parameterized {{date|time +N unit:fmt}}. With no calc and no momentFormat
    // this also resolves bare {{date}} / {{time}} to date.format(format), so it
    // must run before the plain replacements below would short-circuit it.
    result = result.replace(PARAMETERIZED_DATE_TIME_RE, (_match, _which, calc, timeDelta, unit, momentFormat) => {
        const now = moment();
        const currentDate = date.clone().set({
            hour: now.get("hour"),
            minute: now.get("minute"),
            second: now.get("second"),
        });
        if (calc && timeDelta && unit) {
            currentDate.add(parseInt(timeDelta, 10), unit);
        }
        if (momentFormat) {
            return currentDate.format(momentFormat.substring(1).trim());
        }
        return currentDate.format(format);
    });
    // Plain tokens. These are mostly redundant after the parameterized pass but
    // are kept for clarity and for any token shapes the regex above misses.
    result = result.replace(/{{\s*date\s*}}/gi, filename);
    result = result.replace(/{{\s*time\s*}}/gi, moment().format("HH:mm"));
    result = result.replace(/{{\s*title\s*}}/gi, filename);
    if (periodicity === "daily") {
        result = result.replace(/{{\s*yesterday\s*}}/gi, date.clone().subtract(1, "day").format(format));
        result = result.replace(/{{\s*tomorrow\s*}}/gi, date.clone().add(1, "day").format(format));
    }
    if (periodicity === "weekly") {
        result = result.replace(WEEKDAY_TOKEN_RE, (_match, dayOfWeek, momentFormat) => {
            const day = getDayOfWeekNumericalValue(dayOfWeek);
            // Clone before calling `weekday()` — moment's setters mutate.
            return date.clone().weekday(day).format(momentFormat.trim());
        });
    }
    return result;
}
// ---------------------------------------------------------------------------
// Date UID + filename parsing
// ---------------------------------------------------------------------------
function getDateUID(date, periodicity) {
    const unit = PERIODICITY_TO_UNIT[periodicity];
    const ts = date.clone().startOf(unit).format();
    return `${unit}-${ts}`;
}
function removeEscapedCharacters(format) {
    return format.replace(/\[[^\]]*\]/g, "");
}
function isFormatAmbiguous(format, periodicity) {
    if (periodicity !== "weekly")
        return false;
    const cleanFormat = removeEscapedCharacters(format);
    return (/w{1,2}/i.test(cleanFormat) &&
        (/M{1,4}/.test(cleanFormat) || /D{1,4}/.test(cleanFormat)));
}
/**
 * Parse a date out of a filename for a given periodicity, using the supplied
 * format. Returns null if the format is empty or the filename does not match.
 *
 * Mirrors the week-format ambiguity workaround from
 * obsidian-daily-notes-interface: when a weekly format contains both week and
 * month/day tokens, moment will silently ignore the week tokens, so we re-run
 * the parse with M/D tokens stripped.
 */
function getDateFromFilename(filename, periodicity, format) {
    var _a;
    if (!format)
        return null;
    const effectiveFormat = (_a = format.split("/").pop()) !== null && _a !== void 0 ? _a : format;
    const noteDate = moment(filename, effectiveFormat, true);
    if (!noteDate.isValid())
        return null;
    if (isFormatAmbiguous(effectiveFormat, periodicity)) {
        const cleanFormat = removeEscapedCharacters(effectiveFormat);
        if (/w{1,2}/i.test(cleanFormat)) {
            return moment(filename, effectiveFormat.replace(/M{1,4}/g, "").replace(/D{1,4}/g, ""), false);
        }
    }
    return noteDate;
}
function getDateFromFile(file, periodicity, format) {
    return getDateFromFilename(file.basename, periodicity, format);
}
/**
 * Test whether a path lives inside the configured periodic-note folder.
 * Mirrors the recurseChildren semantics of `getAllPeriodicNotes`: an empty
 * folder or "/" means root (the whole vault); otherwise the path must be a
 * descendant of the configured folder.
 *
 * Accepts a raw vault path string so it can be used both for current files
 * (`file.path`) and for the `oldPath` passed by the vault `rename` event.
 */
function isPathInConfiguredFolder(path, settings) {
    var _a, _b;
    const folder = (_b = (_a = settings.folder) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
    if (folder === "" || folder === "/")
        return true;
    const normalized = obsidian.normalizePath(folder);
    return path.startsWith(normalized + "/");
}
/**
 * Convenience wrapper for the common "is this TFile inside the folder?" case.
 */
function isFileInConfiguredFolder(file, settings) {
    return isPathInConfiguredFolder(file.path, settings);
}
// ---------------------------------------------------------------------------
// Vault lookup
// ---------------------------------------------------------------------------
class PeriodicNotesFolderMissingError extends Error {
}
/**
 * Walk the configured folder for a periodicity and return all notes whose
 * basename matches the configured format, keyed by date UID.
 */
function getAllPeriodicNotes(periodicity, settings) {
    var _a, _b;
    const { vault } = window.app;
    const folder = (_b = (_a = settings.folder) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
    // Empty / "/" both mean "scan the entire vault from the root".
    // `vault.getAbstractFileByPath(normalizePath("/"))` is not reliable across
    // Obsidian versions, so use the explicit `vault.getRoot()` for that case.
    let folderObj;
    if (folder === "" || folder === "/") {
        folderObj = vault.getRoot();
    }
    else {
        const found = vault.getAbstractFileByPath(obsidian.normalizePath(folder));
        if (!found || !(found instanceof obsidian.TFolder)) {
            throw new PeriodicNotesFolderMissingError(`Failed to find ${periodicity} notes folder: '${folder}'`);
        }
        folderObj = found;
    }
    const result = {};
    obsidian.Vault.recurseChildren(folderObj, (file) => {
        if (file instanceof obsidian.TFile) {
            const date = getDateFromFile(file, periodicity, settings.format);
            if (date) {
                result[getDateUID(date, periodicity)] = file;
            }
        }
    });
    return result;
}
function getPeriodicNote(date, periodicity, allNotes) {
    var _a;
    return (_a = allNotes[getDateUID(date, periodicity)]) !== null && _a !== void 0 ? _a : null;
}

var DEV = false;

// Store the references to globals in case someone tries to monkey patch these, causing the below
// to de-opt (this occurs often when using popular extensions).
var is_array = Array.isArray;
var index_of = Array.prototype.indexOf;
var includes = Array.prototype.includes;
var array_from = Array.from;
var define_property = Object.defineProperty;
var get_descriptor = Object.getOwnPropertyDescriptor;
var get_descriptors = Object.getOwnPropertyDescriptors;
var object_prototype = Object.prototype;
var array_prototype = Array.prototype;
var get_prototype_of = Object.getPrototypeOf;
var is_extensible = Object.isExtensible;

/**
 * @param {any} thing
 * @returns {thing is Function}
 */
function is_function(thing) {
	return typeof thing === 'function';
}

const noop = () => {};

/** @param {Array<() => void>} arr */
function run_all(arr) {
	for (var i = 0; i < arr.length; i++) {
		arr[i]();
	}
}

/**
 * TODO replace with Promise.withResolvers once supported widely enough
 * @template [T=void]
 */
function deferred() {
	/** @type {(value: T) => void} */
	var resolve;

	/** @type {(reason: any) => void} */
	var reject;

	/** @type {Promise<T>} */
	var promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	// @ts-expect-error
	return { promise, resolve, reject };
}

// General flags
const DERIVED = 1 << 1;
const EFFECT = 1 << 2;
const RENDER_EFFECT = 1 << 3;
/**
 * An effect that does not destroy its child effects when it reruns.
 * Runs as part of render effects, i.e. not eagerly as part of tree traversal or effect flushing.
 */
const MANAGED_EFFECT = 1 << 24;
/**
 * An effect that does not destroy its child effects when it reruns (like MANAGED_EFFECT).
 * Runs eagerly as part of tree traversal or effect flushing.
 */
const BLOCK_EFFECT = 1 << 4;
const BRANCH_EFFECT = 1 << 5;
const ROOT_EFFECT = 1 << 6;
const BOUNDARY_EFFECT = 1 << 7;
/**
 * Indicates that a reaction is connected to an effect root — either it is an effect,
 * or it is a derived that is depended on by at least one effect. If a derived has
 * no dependents, we can disconnect it from the graph, allowing it to either be
 * GC'd or reconnected later if an effect comes to depend on it again
 */
const CONNECTED = 1 << 9;
const CLEAN = 1 << 10;
const DIRTY = 1 << 11;
const MAYBE_DIRTY = 1 << 12;
const INERT = 1 << 13;
const DESTROYED = 1 << 14;
/** Set once a reaction has run for the first time */
const REACTION_RAN = 1 << 15;
/** Effect is in the process of getting destroyed. Can be observed in child teardown functions */
const DESTROYING = 1 << 25;

// Flags exclusive to effects
/**
 * 'Transparent' effects do not create a transition boundary.
 * This is on a block effect 99% of the time but may also be on a branch effect if its parent block effect was pruned
 */
const EFFECT_TRANSPARENT = 1 << 16;
const EAGER_EFFECT = 1 << 17;
const HEAD_EFFECT = 1 << 18;
const EFFECT_PRESERVED = 1 << 19;
const USER_EFFECT = 1 << 20;
const EFFECT_OFFSCREEN = 1 << 25;

// Flags exclusive to deriveds
/**
 * Tells that we marked this derived and its reactions as visited during the "mark as (maybe) dirty"-phase.
 * Will be lifted during execution of the derived and during checking its dirty state (both are necessary
 * because a derived might be checked but not executed). This is a pure performance optimization flag and
 * should not be used for any other purpose!
 */
const WAS_MARKED = 1 << 16;

// Flags used for async
const REACTION_IS_UPDATING = 1 << 21;
const ASYNC = 1 << 22;

const ERROR_VALUE = 1 << 23;

const STATE_SYMBOL = Symbol('$state');
const LEGACY_PROPS = Symbol('legacy props');
const LOADING_ATTR_SYMBOL = Symbol('');
const ATTRIBUTES_CACHE = Symbol('attributes');
const CLASS_CACHE = Symbol('class');
const STYLE_CACHE = Symbol('style');
const TEXT_CACHE = Symbol('text');

/** allow users to ignore aborted signal errors if `reason.name === 'StaleReactionError` */
const STALE_REACTION = new (class StaleReactionError extends Error {
	name = 'StaleReactionError';
	message = 'The reaction that called `getAbortSignal()` was re-run or destroyed';
})();

const IS_XHTML =
	// We gotta write it like this because after downleveling the pure comment may end up in the wrong location
	!!globalThis.document?.contentType &&
	/* @__PURE__ */ globalThis.document.contentType.includes('xml');

/** @import { Equals } from '#client' */

/** @type {Equals} */
function equals(value) {
	return value === this.v;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function safe_not_equal(a, b) {
	return a != a
		? b == b
		: a !== b || (a !== null && typeof a === 'object') || typeof a === 'function';
}

/** @type {Equals} */
function safe_equals(value) {
	return !safe_not_equal(value, this.v);
}

/* This file is generated by scripts/process-messages/index.js. Do not edit! */


/**
 * Cannot create a `$derived(...)` with an `await` expression outside of an effect tree
 * @returns {never}
 */
function async_derived_orphan() {
	{
		throw new Error(`https://svelte.dev/e/async_derived_orphan`);
	}
}

/**
 * Keyed each block has duplicate key `%value%` at indexes %a% and %b%
 * @param {string} a
 * @param {string} b
 * @param {string | undefined | null} [value]
 * @returns {never}
 */
function each_key_duplicate(a, b, value) {
	{
		throw new Error(`https://svelte.dev/e/each_key_duplicate`);
	}
}

/**
 * `%rune%` cannot be used inside an effect cleanup function
 * @param {string} rune
 * @returns {never}
 */
function effect_in_teardown(rune) {
	{
		throw new Error(`https://svelte.dev/e/effect_in_teardown`);
	}
}

/**
 * Effect cannot be created inside a `$derived` value that was not itself created inside an effect
 * @returns {never}
 */
function effect_in_unowned_derived() {
	{
		throw new Error(`https://svelte.dev/e/effect_in_unowned_derived`);
	}
}

/**
 * `%rune%` can only be used inside an effect (e.g. during component initialisation)
 * @param {string} rune
 * @returns {never}
 */
function effect_orphan(rune) {
	{
		throw new Error(`https://svelte.dev/e/effect_orphan`);
	}
}

/**
 * Maximum update depth exceeded. This typically indicates that an effect reads and writes the same piece of state
 * @returns {never}
 */
function effect_update_depth_exceeded() {
	{
		throw new Error(`https://svelte.dev/e/effect_update_depth_exceeded`);
	}
}

/**
 * Cannot do `bind:%key%={undefined}` when `%key%` has a fallback value
 * @param {string} key
 * @returns {never}
 */
function props_invalid_value(key) {
	{
		throw new Error(`https://svelte.dev/e/props_invalid_value`);
	}
}

/**
 * Property descriptors defined on `$state` objects must contain `value` and always be `enumerable`, `configurable` and `writable`.
 * @returns {never}
 */
function state_descriptors_fixed() {
	{
		throw new Error(`https://svelte.dev/e/state_descriptors_fixed`);
	}
}

/**
 * Cannot set prototype of `$state` object
 * @returns {never}
 */
function state_prototype_fixed() {
	{
		throw new Error(`https://svelte.dev/e/state_prototype_fixed`);
	}
}

/**
 * Updating state inside `$derived(...)`, `$inspect(...)` or a template expression is forbidden. If the value should not be reactive, declare it without `$state`
 * @returns {never}
 */
function state_unsafe_mutation() {
	{
		throw new Error(`https://svelte.dev/e/state_unsafe_mutation`);
	}
}

/**
 * A `<svelte:boundary>` `reset` function cannot be called while an error is still being handled
 * @returns {never}
 */
function svelte_boundary_reset_onerror() {
	{
		throw new Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`);
	}
}

/** True if experimental.async=true */
/** True if $inspect.trace is used */
let tracing_mode_flag = false;

const EACH_ITEM_REACTIVE = 1;
const EACH_INDEX_REACTIVE = 1 << 1;
/** See EachBlock interface metadata.is_controlled for an explanation what this is */
const EACH_IS_CONTROLLED = 1 << 2;
const EACH_IS_ANIMATED = 1 << 3;
const EACH_ITEM_IMMUTABLE = 1 << 4;

const PROPS_IS_IMMUTABLE = 1;
const PROPS_IS_UPDATED = 1 << 2;
const PROPS_IS_BINDABLE = 1 << 3;
const PROPS_IS_LAZY_INITIAL = 1 << 4;

const TEMPLATE_FRAGMENT = 1;
const TEMPLATE_USE_IMPORT_NODE = 1 << 1;

const UNINITIALIZED = Symbol('uninitialized');

const NAMESPACE_HTML = 'http://www.w3.org/1999/xhtml';

const ATTACHMENT_KEY = '@attach';

/** @import { ComponentContext, DevStackEntry, Effect } from '#client' */

/** @type {ComponentContext | null} */
let component_context = null;

/** @param {ComponentContext | null} context */
function set_component_context(context) {
	component_context = context;
}

/**
 * @param {Record<string, unknown>} props
 * @param {any} runes
 * @param {Function} [fn]
 * @returns {void}
 */
function push(props, runes = false, fn) {
	component_context = {
		p: component_context,
		i: false,
		c: null,
		e: null,
		s: props,
		x: null,
		r: /** @type {Effect} */ (active_effect),
		l: null
	};
}

/**
 * @template {Record<string, any>} T
 * @param {T} [component]
 * @returns {T}
 */
function pop(component) {
	var context = /** @type {ComponentContext} */ (component_context);
	var effects = context.e;

	if (effects !== null) {
		context.e = null;

		for (var fn of effects) {
			create_user_effect(fn);
		}
	}

	if (component !== undefined) {
		context.x = component;
	}

	context.i = true;

	component_context = context.p;

	return component ?? /** @type {T} */ ({});
}

/** @returns {boolean} */
function is_runes() {
	return true;
}

/** @type {Array<() => void>} */
let micro_tasks = [];

function run_micro_tasks() {
	var tasks = micro_tasks;
	micro_tasks = [];
	run_all(tasks);
}

/**
 * @param {() => void} fn
 */
function queue_micro_task(fn) {
	if (micro_tasks.length === 0 && true) {
		var tasks = micro_tasks;
		queueMicrotask(() => {
			// If this is false, a flushSync happened in the meantime. Do _not_ run new scheduled microtasks in that case
			// as the ordering of microtasks would be broken at that point - consider this case:
			// - queue_micro_task schedules microtask A to flush task X
			// - synchronously after, flushSync runs, processing task X
			// - synchronously after, some other microtask B is scheduled, but not through queue_micro_task but for example a Promise.resolve() in user code
			// - synchronously after, queue_micro_task schedules microtask C to flush task Y
			// - one tick later, microtask A now resolves, flushing task Y before microtask B, which is incorrect
			// This if check prevents that race condition (that realistically will only happen in tests)
			if (tasks === micro_tasks) run_micro_tasks();
		});
	}

	micro_tasks.push(fn);
}

/* This file is generated by scripts/process-messages/index.js. Do not edit! */


/**
 * Reading a derived belonging to a now-destroyed effect may result in stale values
 */
function derived_inert() {
	{
		console.warn(`https://svelte.dev/e/derived_inert`);
	}
}

/**
 * The `value` property of a `<select multiple>` element should be an array, but it received a non-array value. The selection will be kept as is.
 */
function select_multiple_invalid_value() {
	{
		console.warn(`https://svelte.dev/e/select_multiple_invalid_value`);
	}
}

/**
 * A `<svelte:boundary>` `reset` function only resets the boundary the first time it is called
 */
function svelte_boundary_reset_noop() {
	{
		console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`);
	}
}

/** @import { Source } from '#client' */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function proxy(value) {
	// if non-proxyable, or is already a proxy, return `value`
	if (typeof value !== 'object' || value === null || STATE_SYMBOL in value) {
		return value;
	}

	const prototype = get_prototype_of(value);

	if (prototype !== object_prototype && prototype !== array_prototype) {
		return value;
	}

	/** @type {Map<any, Source<any>>} */
	var sources = new Map();
	var is_proxied_array = is_array(value);
	var version = state(0);
	var parent_version = update_version;

	/**
	 * Executes the proxy in the context of the reaction it was originally created in, if any
	 * @template T
	 * @param {() => T} fn
	 */
	var with_parent = (fn) => {
		if (update_version === parent_version) {
			return fn();
		}

		// child source is being created after the initial proxy —
		// prevent it from being associated with the current reaction
		var reaction = active_reaction;
		var version = update_version;

		set_active_reaction(null);
		set_update_version(parent_version);

		var result = fn();

		set_active_reaction(reaction);
		set_update_version(version);

		return result;
	};

	if (is_proxied_array) {
		// We need to create the length source eagerly to ensure that
		// mutations to the array are properly synced with our proxy
		sources.set('length', state(/** @type {any[]} */ (value).length));
	}

	return new Proxy(/** @type {any} */ (value), {
		defineProperty(_, prop, descriptor) {
			if (
				!('value' in descriptor) ||
				descriptor.configurable === false ||
				descriptor.enumerable === false ||
				descriptor.writable === false
			) {
				// we disallow non-basic descriptors, because unless they are applied to the
				// target object — which we avoid, so that state can be forked — we will run
				// afoul of the various invariants
				// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/getOwnPropertyDescriptor#invariants
				state_descriptors_fixed();
			}
			var s = sources.get(prop);
			if (s === undefined) {
				with_parent(() => {
					var s = state(descriptor.value);
					sources.set(prop, s);
					return s;
				});
			} else {
				set(s, descriptor.value, true);
			}

			return true;
		},

		deleteProperty(target, prop) {
			var s = sources.get(prop);

			if (s === undefined) {
				if (prop in target) {
					const s = with_parent(() => state(UNINITIALIZED));
					sources.set(prop, s);
					increment(version);
				}
			} else {
				set(s, UNINITIALIZED);
				increment(version);
			}

			return true;
		},

		get(target, prop, receiver) {
			if (prop === STATE_SYMBOL) {
				return value;
			}

			var s = sources.get(prop);
			var exists = prop in target;

			// create a source, but only if it's an own property and not a prototype property
			if (s === undefined && (!exists || get_descriptor(target, prop)?.writable)) {
				s = with_parent(() => {
					var p = proxy(exists ? target[prop] : UNINITIALIZED);
					var s = state(p);

					return s;
				});

				sources.set(prop, s);
			}

			if (s !== undefined) {
				var v = get(s);
				return v === UNINITIALIZED ? undefined : v;
			}

			return Reflect.get(target, prop, receiver);
		},

		getOwnPropertyDescriptor(target, prop) {
			var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

			if (descriptor && 'value' in descriptor) {
				var s = sources.get(prop);
				if (s) descriptor.value = get(s);
			} else if (descriptor === undefined) {
				var source = sources.get(prop);
				var value = source?.v;

				if (source !== undefined && value !== UNINITIALIZED) {
					return {
						enumerable: true,
						configurable: true,
						value,
						writable: true
					};
				}
			}

			return descriptor;
		},

		has(target, prop) {
			if (prop === STATE_SYMBOL) {
				return true;
			}

			var s = sources.get(prop);
			var has = (s !== undefined && s.v !== UNINITIALIZED) || Reflect.has(target, prop);

			if (
				s !== undefined ||
				(active_effect !== null && (!has || get_descriptor(target, prop)?.writable))
			) {
				if (s === undefined) {
					s = with_parent(() => {
						var p = has ? proxy(target[prop]) : UNINITIALIZED;
						var s = state(p);

						return s;
					});

					sources.set(prop, s);
				}

				var value = get(s);
				if (value === UNINITIALIZED) {
					return false;
				}
			}

			return has;
		},

		set(target, prop, value, receiver) {
			var s = sources.get(prop);
			var has = prop in target;

			// variable.length = value -> clear all signals with index >= value
			if (is_proxied_array && prop === 'length') {
				for (var i = value; i < /** @type {Source<number>} */ (s).v; i += 1) {
					var other_s = sources.get(i + '');
					if (other_s !== undefined) {
						set(other_s, UNINITIALIZED);
					} else if (i in target) {
						// If the item exists in the original, we need to create an uninitialized source,
						// else a later read of the property would result in a source being created with
						// the value of the original item at that index.
						other_s = with_parent(() => state(UNINITIALIZED));
						sources.set(i + '', other_s);
					}
				}
			}

			// If we haven't yet created a source for this property, we need to ensure
			// we do so otherwise if we read it later, then the write won't be tracked and
			// the heuristics of effects will be different vs if we had read the proxied
			// object property before writing to that property.
			if (s === undefined) {
				if (!has || get_descriptor(target, prop)?.writable) {
					s = with_parent(() => state(undefined));
					set(s, proxy(value));

					sources.set(prop, s);
				}
			} else {
				has = s.v !== UNINITIALIZED;

				var p = with_parent(() => proxy(value));
				set(s, p);
			}

			var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

			// Set the new value before updating any signals so that any listeners get the new value
			if (descriptor?.set) {
				descriptor.set.call(receiver, value);
			}

			if (!has) {
				// If we have mutated an array directly, we might need to
				// signal that length has also changed. Do it before updating metadata
				// to ensure that iterating over the array as a result of a metadata update
				// will not cause the length to be out of sync.
				if (is_proxied_array && typeof prop === 'string') {
					var ls = /** @type {Source<number>} */ (sources.get('length'));
					var n = Number(prop);

					if (Number.isInteger(n) && n >= ls.v) {
						set(ls, n + 1);
					}
				}

				increment(version);
			}

			return true;
		},

		ownKeys(target) {
			get(version);

			var own_keys = Reflect.ownKeys(target).filter((key) => {
				var source = sources.get(key);
				return source === undefined || source.v !== UNINITIALIZED;
			});

			for (var [key, source] of sources) {
				if (source.v !== UNINITIALIZED && !(key in target)) {
					own_keys.push(key);
				}
			}

			return own_keys;
		},

		setPrototypeOf() {
			state_prototype_fixed();
		}
	});
}

/**
 * @param {any} value
 */
function get_proxied_value(value) {
	try {
		if (value !== null && typeof value === 'object' && STATE_SYMBOL in value) {
			return value[STATE_SYMBOL];
		}
	} catch {
		// the above if check can throw an error if the value in question
		// is the contentWindow of an iframe on another domain, in which
		// case we want to just return the value (because it's definitely
		// not a proxied value) so we don't break any JavaScript interacting
		// with that iframe (such as various payment companies client side
		// JavaScript libraries interacting with their iframes on the same
		// domain)
	}

	return value;
}

/**
 * @param {any} a
 * @param {any} b
 */
function is(a, b) {
	return Object.is(get_proxied_value(a), get_proxied_value(b));
}

/** @import { Effect, TemplateNode } from '#client' */

// export these for reference in the compiled code, making global name deduplication unnecessary
/** @type {Window} */
var $window;

/** @type {boolean} */
var is_firefox;

/** @type {() => Node | null} */
var first_child_getter;
/** @type {() => Node | null} */
var next_sibling_getter;

/**
 * Initialize these lazily to avoid issues when using the runtime in a server context
 * where these globals are not available while avoiding a separate server entry point
 */
function init_operations() {
	if ($window !== undefined) {
		return;
	}

	$window = window;
	is_firefox = /Firefox/.test(navigator.userAgent);

	var element_prototype = Element.prototype;
	var node_prototype = Node.prototype;
	var text_prototype = Text.prototype;

	// @ts-ignore
	first_child_getter = get_descriptor(node_prototype, 'firstChild').get;
	// @ts-ignore
	next_sibling_getter = get_descriptor(node_prototype, 'nextSibling').get;

	if (is_extensible(element_prototype)) {
		// the following assignments improve perf of lookups on DOM nodes
		/** @type {any} */ (element_prototype)[CLASS_CACHE] = undefined;
		/** @type {any} */ (element_prototype)[ATTRIBUTES_CACHE] = null;
		/** @type {any} */ (element_prototype)[STYLE_CACHE] = undefined;
		// @ts-expect-error
		element_prototype.__e = undefined;
	}

	if (is_extensible(text_prototype)) {
		/** @type {any} */ (text_prototype)[TEXT_CACHE] = undefined;
	}
}

/**
 * @param {string} value
 * @returns {Text}
 */
function create_text(value = '') {
	return document.createTextNode(value);
}

/**
 * @template {Node} N
 * @param {N} node
 */
/*@__NO_SIDE_EFFECTS__*/
function get_first_child(node) {
	return /** @type {TemplateNode | null} */ (first_child_getter.call(node));
}

/**
 * @template {Node} N
 * @param {N} node
 */
/*@__NO_SIDE_EFFECTS__*/
function get_next_sibling(node) {
	return /** @type {TemplateNode | null} */ (next_sibling_getter.call(node));
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 * @template {Node} N
 * @param {N} node
 * @param {boolean} is_text
 * @returns {TemplateNode | null}
 */
function child(node, is_text) {
	{
		return get_first_child(node);
	}
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 * @param {TemplateNode} node
 * @param {boolean} [is_text]
 * @returns {TemplateNode | null}
 */
function first_child(node, is_text = false) {
	{
		var first = get_first_child(node);

		// TODO prevent user comments with the empty string when preserveComments is true
		if (first instanceof Comment && first.data === '') return get_next_sibling(first);

		return first;
	}
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 * @param {TemplateNode} node
 * @param {number} count
 * @param {boolean} is_text
 * @returns {TemplateNode | null}
 */
function sibling(node, count = 1, is_text = false) {
	let next_sibling = node;

	while (count--) {
		next_sibling = /** @type {TemplateNode} */ (get_next_sibling(next_sibling));
	}

	{
		return next_sibling;
	}
}

/**
 * @template {Node} N
 * @param {N} node
 * @returns {void}
 */
function clear_text_content(node) {
	node.textContent = '';
}

/**
 * Returns `true` if we're updating the current block, for example `condition` in
 * an `{#if condition}` block just changed. In this case, the branch should be
 * appended (or removed) at the same time as other updates within the
 * current `<svelte:boundary>`
 */
function should_defer_append() {
	return false;
}

/**
 * Branching here is intentional and load-bearing for perf. `createElement(tag)`
 * hits a fast path in Blink that `createElementNS(NAMESPACE_HTML, tag)` doesn't,
 * and passing an explicit `undefined` as the trailing options arg measurably
 * slows both APIs. Funnelling every case through a single `createElementNS(ns,
 * tag, options)` call would be smaller but slower on the HTML path.
 *
 * @template {keyof HTMLElementTagNameMap | string} T
 * @param {T} tag
 * @param {string} [namespace]
 * @param {string} [is]
 * @returns {T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : Element}
 */
function create_element(tag, namespace, is) {
	{
		return /** @type {T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : Element} */ (
			is ? document.createElement(tag, { is }) : document.createElement(tag)
		);
	}
}

/** @import { Derived, Effect } from '#client' */
/** @import { Boundary } from './dom/blocks/boundary.js' */

/**
 * @param {unknown} error
 */
function handle_error(error) {
	var effect = active_effect;

	// for unowned deriveds, don't throw until we read the value
	if (effect === null) {
		/** @type {Derived} */ (active_reaction).f |= ERROR_VALUE;
		return error;
	}

	// if the error occurred while creating this subtree, we let it
	// bubble up until it hits a boundary that can handle it, unless
	// it's an $effect in which case it doesn't run immediately
	if ((effect.f & REACTION_RAN) === 0 && (effect.f & EFFECT) === 0) {

		throw error;
	}

	// otherwise we bubble up the effect tree ourselves
	invoke_error_boundary(error, effect);
}

/**
 * @param {unknown} error
 * @param {Effect | null} effect
 */
function invoke_error_boundary(error, effect) {
	if (effect !== null && (effect.f & DESTROYED) !== 0) {
		return;
	}

	while (effect !== null) {
		if ((effect.f & BOUNDARY_EFFECT) !== 0) {
			if ((effect.f & REACTION_RAN) === 0) {
				// we are still creating the boundary effect
				throw error;
			}

			try {
				/** @type {Boundary} */ (effect.b).error(error);
				return;
			} catch (e) {
				error = e;
			}
		}

		effect = effect.parent;
	}

	throw error;
}

/** @import { Derived, Signal } from '#client' */

const STATUS_MASK = -7169;

/**
 * @param {Signal} signal
 * @param {number} status
 */
function set_signal_status(signal, status) {
	signal.f = (signal.f & STATUS_MASK) | status;
}

/**
 * Set a derived's status to CLEAN or MAYBE_DIRTY based on its connection state.
 * @param {Derived} derived
 */
function update_derived_status(derived) {
	// Only mark as MAYBE_DIRTY if disconnected and has dependencies.
	if ((derived.f & CONNECTED) !== 0 || derived.deps === null) {
		set_signal_status(derived, CLEAN);
	} else {
		set_signal_status(derived, MAYBE_DIRTY);
	}
}

/** @import { Derived, Effect, Value } from '#client' */

/**
 * @param {Value[] | null} deps
 */
function clear_marked(deps) {
	if (deps === null) return;

	for (const dep of deps) {
		if ((dep.f & DERIVED) === 0 || (dep.f & WAS_MARKED) === 0) {
			continue;
		}

		dep.f ^= WAS_MARKED;

		clear_marked(/** @type {Derived} */ (dep).deps);
	}
}

/**
 * @param {Effect} effect
 * @param {Set<Effect>} dirty_effects
 * @param {Set<Effect>} maybe_dirty_effects
 */
function defer_effect(effect, dirty_effects, maybe_dirty_effects) {
	if ((effect.f & DIRTY) !== 0) {
		dirty_effects.add(effect);
	} else if ((effect.f & MAYBE_DIRTY) !== 0) {
		maybe_dirty_effects.add(effect);
	}

	// Since we're not executing these effects now, we need to clear any WAS_MARKED flags
	// so that other batches can correctly reach these effects during their own traversal
	clear_marked(effect.deps);

	// mark as clean so they get scheduled if they depend on pending async state
	set_signal_status(effect, CLEAN);
}

/** @import { Readable } from './public' */

/**
 * @template T
 * @param {Readable<T> | null | undefined} store
 * @param {(value: T) => void} run
 * @param {(value: T) => void} [invalidate]
 * @returns {() => void}
 */
function subscribe_to_store(store, run, invalidate) {
	if (store == null) {
		// @ts-expect-error
		run(undefined);

		return noop;
	}

	// Svelte store takes a private second argument
	// StartStopNotifier could mutate state, and we want to silence the corresponding validation error
	const unsub = untrack(() =>
		store.subscribe(
			run,
			// @ts-expect-error
			invalidate
		)
	);

	// Also support RxJS
	// @ts-expect-error TODO fix this in the types?
	return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
}

/** @import { Readable, StartStopNotifier, Subscriber, Unsubscriber, Updater, Writable } from '../public.js' */
/** @import { Stores, StoresValues, SubscribeInvalidateTuple } from '../private.js' */

/**
 * @type {Array<SubscribeInvalidateTuple<any> | any>}
 */
const subscriber_queue = [];

/**
 * Create a `Writable` store that allows both updating and reading by subscription.
 *
 * @template T
 * @param {T} [value] initial value
 * @param {StartStopNotifier<T>} [start]
 * @returns {Writable<T>}
 */
function writable(value, start = noop) {
	/** @type {Unsubscriber | null} */
	let stop = null;

	/** @type {Set<SubscribeInvalidateTuple<T>>} */
	const subscribers = new Set();

	/**
	 * @param {T} new_value
	 * @returns {void}
	 */
	function set(new_value) {
		if (safe_not_equal(value, new_value)) {
			value = new_value;
			if (stop) {
				// store is ready
				const run_queue = !subscriber_queue.length;
				for (const subscriber of subscribers) {
					subscriber[1]();
					subscriber_queue.push(subscriber, value);
				}
				if (run_queue) {
					for (let i = 0; i < subscriber_queue.length; i += 2) {
						subscriber_queue[i][0](subscriber_queue[i + 1]);
					}
					subscriber_queue.length = 0;
				}
			}
		}
	}

	/**
	 * @param {Updater<T>} fn
	 * @returns {void}
	 */
	function update(fn) {
		set(fn(/** @type {T} */ (value)));
	}

	/**
	 * @param {Subscriber<T>} run
	 * @param {() => void} [invalidate]
	 * @returns {Unsubscriber}
	 */
	function subscribe(run, invalidate = noop) {
		/** @type {SubscribeInvalidateTuple<T>} */
		const subscriber = [run, invalidate];
		subscribers.add(subscriber);
		if (subscribers.size === 1) {
			stop = start(set, update) || noop;
		}
		run(/** @type {T} */ (value));
		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0 && stop) {
				stop();
				stop = null;
			}
		};
	}
	return { set, update, subscribe };
}

/**
 * Get the current value from a store by subscribing and immediately unsubscribing.
 *
 * @template T
 * @param {Readable<T>} store
 * @returns {T}
 */
function get$1(store) {
	let value;
	subscribe_to_store(store, (_) => (value = _))();
	// @ts-expect-error
	return value;
}

/** @import { StoreReferencesContainer } from '#client' */
/** @import { Store } from '#shared' */

/**
 * Whether or not the prop currently being read is a store binding, as in
 * `<Child bind:x={$y} />`. If it is, we treat the prop as mutable even in
 * runes mode, and skip `binding_property_non_reactive` validation
 */
let is_store_binding = false;

let IS_UNMOUNTED = Symbol('unmounted');

/**
 * Gets the current value of a store. If the store isn't subscribed to yet, it will create a proxy
 * signal that will be updated when the store is. The store references container is needed to
 * track reassignments to stores and to track the correct component context.
 * @template V
 * @param {Store<V> | null | undefined} store
 * @param {string} store_name
 * @param {StoreReferencesContainer} stores
 * @returns {V}
 */
function store_get(store, store_name, stores) {
	const entry = (stores[store_name] ??= {
		store: null,
		source: mutable_source(undefined),
		unsubscribe: noop
	});

	// if the component that setup this is already unmounted we don't want to register a subscription
	if (entry.store !== store && !(IS_UNMOUNTED in stores)) {
		entry.unsubscribe();
		entry.store = store ?? null;

		if (store == null) {
			entry.source.v = undefined; // see synchronous callback comment below
			entry.unsubscribe = noop;
		} else {
			var is_synchronous_callback = true;

			entry.unsubscribe = subscribe_to_store(store, (v) => {
				if (is_synchronous_callback) {
					// If the first updates to the store value (possibly multiple of them) are synchronously
					// inside a derived, we will hit the `state_unsafe_mutation` error if we `set` the value
					entry.source.v = v;
				} else {
					set(entry.source, v);
				}
			});

			is_synchronous_callback = false;
		}
	}

	// if the component that setup this stores is already unmounted the source will be out of sync
	// so we just use the `get` for the stores, less performant but it avoids to create a memory leak
	// and it will keep the value consistent
	if (store && IS_UNMOUNTED in stores) {
		return get$1(store);
	}

	return get(entry.source);
}

/**
 * Unsubscribes from all auto-subscribed stores on destroy
 * @returns {[StoreReferencesContainer, ()=>void]}
 */
function setup_stores() {
	/** @type {StoreReferencesContainer} */
	const stores = {};

	function cleanup() {
		teardown(() => {
			for (var store_name in stores) {
				const ref = stores[store_name];
				ref.unsubscribe();
			}
			define_property(stores, IS_UNMOUNTED, {
				enumerable: false,
				value: true
			});
		});
	}

	return [stores, cleanup];
}

/**
 * Returns a tuple that indicates whether `fn()` reads a prop that is a store binding.
 * Used to prevent `binding_property_non_reactive` validation false positives and
 * ensure that these props are treated as mutable even in runes mode
 * @template T
 * @param {() => T} fn
 * @returns {[T, boolean]}
 */
function capture_store_binding(fn) {
	var previous_is_store_binding = is_store_binding;

	try {
		is_store_binding = false;
		return [fn(), is_store_binding];
	} finally {
		is_store_binding = previous_is_store_binding;
	}
}

/**
 * Returns a `subscribe` function that integrates external event-based systems with Svelte's reactivity.
 * It's particularly useful for integrating with web APIs like `MediaQuery`, `IntersectionObserver`, or `WebSocket`.
 *
 * If `subscribe` is called inside an effect (including indirectly, for example inside a getter),
 * the `start` callback will be called with an `update` function. Whenever `update` is called, the effect re-runs.
 *
 * If `start` returns a cleanup function, it will be called when the effect is destroyed.
 *
 * If `subscribe` is called in multiple effects, `start` will only be called once as long as the effects
 * are active, and the returned teardown function will only be called when all effects are destroyed.
 *
 * It's best understood with an example. Here's an implementation of [`MediaQuery`](https://svelte.dev/docs/svelte/svelte-reactivity#MediaQuery):
 *
 * ```js
 * import { createSubscriber } from 'svelte/reactivity';
 * import { on } from 'svelte/events';
 *
 * export class MediaQuery {
 * 	#query;
 * 	#subscribe;
 *
 * 	constructor(query) {
 * 		this.#query = window.matchMedia(`(${query})`);
 *
 * 		this.#subscribe = createSubscriber((update) => {
 * 			// when the `change` event occurs, re-run any effects that read `this.current`
 * 			const off = on(this.#query, 'change', update);
 *
 * 			// stop listening when all the effects are destroyed
 * 			return () => off();
 * 		});
 * 	}
 *
 * 	get current() {
 * 		// This makes the getter reactive, if read in an effect
 * 		this.#subscribe();
 *
 * 		// Return the current state of the query, whether or not we're in an effect
 * 		return this.#query.matches;
 * 	}
 * }
 * ```
 * @param {(update: () => void) => (() => void) | void} start
 * @since 5.7.0
 */
function createSubscriber(start) {
	let subscribers = 0;
	let version = source(0);
	/** @type {(() => void) | void} */
	let stop;

	return () => {
		if (effect_tracking()) {
			get(version);

			render_effect(() => {
				if (subscribers === 0) {
					stop = untrack(() => start(() => increment(version)));
				}

				subscribers += 1;

				return () => {
					queue_micro_task(() => {
						// Only count down after a microtask, else we would reach 0 before our own render effect reruns,
						// but reach 1 again when the tick callback of the prior teardown runs. That would mean we
						// re-subcribe unnecessarily and create a memory leak because the old subscription is never cleaned up.
						subscribers -= 1;

						if (subscribers === 0) {
							stop?.();
							stop = undefined;
							// Increment the version to ensure any dependent deriveds are marked dirty when the subscription is picked up again later.
							// If we didn't do this then the comparison of write versions would determine that the derived has a later version than
							// the subscriber, and it would not be re-run.
							increment(version);
						}
					});
				};
			});
		}
	};
}

/** @import { Effect, Source, TemplateNode, } from '#client' */

/**
 * @typedef {{
 * 	 onerror?: ((error: unknown, reset: () => void) => void) | null;
 *   failed?: ((anchor: Node, error: () => unknown, reset: () => () => void) => void) | null;
 *   pending?: ((anchor: Node) => void) | null;
 * }} BoundaryProps
 */

var flags = EFFECT_TRANSPARENT | EFFECT_PRESERVED;

/**
 * @param {TemplateNode} node
 * @param {BoundaryProps} props
 * @param {((anchor: Node) => void)} children
 * @param {((error: unknown) => unknown) | undefined} [transform_error]
 * @returns {void}
 */
function boundary(node, props, children, transform_error) {
	new Boundary(node, props, children, transform_error);
}

class Boundary {
	/** @type {Boundary | null} */
	parent;

	is_pending = false;

	/**
	 * API-level transformError transform function. Transforms errors before they reach the `failed` snippet.
	 * Inherited from parent boundary, or defaults to identity.
	 * @type {(error: unknown) => unknown}
	 */
	transform_error;

	/** @type {TemplateNode} */
	#anchor;

	/** @type {TemplateNode | null} */
	#hydrate_open = null;

	/** @type {BoundaryProps} */
	#props;

	/** @type {((anchor: Node) => void)} */
	#children;

	/** @type {Effect} */
	#effect;

	/** @type {Effect | null} */
	#main_effect = null;

	/** @type {Effect | null} */
	#pending_effect = null;

	/** @type {Effect | null} */
	#failed_effect = null;

	/** @type {DocumentFragment | null} */
	#offscreen_fragment = null;

	#local_pending_count = 0;
	#pending_count = 0;
	#pending_count_update_queued = false;

	/** @type {Set<Effect>} */
	#dirty_effects = new Set();

	/** @type {Set<Effect>} */
	#maybe_dirty_effects = new Set();

	/**
	 * A source containing the number of pending async deriveds/expressions.
	 * Only created if `$effect.pending()` is used inside the boundary,
	 * otherwise updating the source results in needless `Batch.ensure()`
	 * calls followed by no-op flushes
	 * @type {Source<number> | null}
	 */
	#effect_pending = null;

	#effect_pending_subscriber = createSubscriber(() => {
		this.#effect_pending = source(this.#local_pending_count);

		return () => {
			this.#effect_pending = null;
		};
	});

	/**
	 * @param {TemplateNode} node
	 * @param {BoundaryProps} props
	 * @param {((anchor: Node) => void)} children
	 * @param {((error: unknown) => unknown) | undefined} [transform_error]
	 */
	constructor(node, props, children, transform_error) {
		this.#anchor = node;
		this.#props = props;

		this.#children = (anchor) => {
			var effect = /** @type {Effect} */ (active_effect);

			effect.b = this;
			effect.f |= BOUNDARY_EFFECT;

			children(anchor);
		};

		this.parent = /** @type {Effect} */ (active_effect).b;

		// Inherit transform_error from parent boundary, or use the provided one, or default to identity
		this.transform_error = transform_error ?? this.parent?.transform_error ?? ((e) => e);

		this.#effect = block(() => {
			{
				this.#render();
			}
		}, flags);
	}

	#hydrate_resolved_content() {
		try {
			this.#main_effect = branch(() => this.#children(this.#anchor));
		} catch (error) {
			this.error(error);
		}
	}

	/**
	 * @param {unknown} error The deserialized error from the server's hydration comment
	 */
	#hydrate_failed_content(error) {
		const failed = this.#props.failed;
		if (!failed) return;

		this.#failed_effect = branch(() => {
			failed(
				this.#anchor,
				() => error,
				() => () => {}
			);
		});
	}

	#hydrate_pending_content() {
		const pending = this.#props.pending;
		if (!pending) return;

		this.is_pending = true;
		this.#pending_effect = branch(() => pending(this.#anchor));

		queue_micro_task(() => {
			var fragment = (this.#offscreen_fragment = document.createDocumentFragment());
			var anchor = create_text();

			fragment.append(anchor);

			this.#main_effect = this.#run(() => {
				return branch(() => this.#children(anchor));
			});

			if (this.#pending_count === 0) {
				this.#anchor.before(fragment);
				this.#offscreen_fragment = null;

				pause_effect(/** @type {Effect} */ (this.#pending_effect), () => {
					this.#pending_effect = null;
				});

				this.#resolve(/** @type {Batch} */ (current_batch));
			}
		});
	}

	#render() {
		try {
			this.is_pending = this.has_pending_snippet();
			this.#pending_count = 0;
			this.#local_pending_count = 0;

			this.#main_effect = branch(() => {
				this.#children(this.#anchor);
			});

			if (this.#pending_count > 0) {
				var fragment = (this.#offscreen_fragment = document.createDocumentFragment());
				move_effect(this.#main_effect, fragment);

				const pending = /** @type {(anchor: Node) => void} */ (this.#props.pending);
				this.#pending_effect = branch(() => pending(this.#anchor));
			} else {
				this.#resolve(/** @type {Batch} */ (current_batch));
			}
		} catch (error) {
			this.error(error);
		}
	}

	/**
	 * @param {Batch} batch
	 */
	#resolve(batch) {
		this.is_pending = false;

		// any effects that were previously deferred should be transferred
		// to the batch, which will flush in the next microtask
		batch.transfer_effects(this.#dirty_effects, this.#maybe_dirty_effects);
	}

	/**
	 * Defer an effect inside a pending boundary until the boundary resolves
	 * @param {Effect} effect
	 */
	defer_effect(effect) {
		defer_effect(effect, this.#dirty_effects, this.#maybe_dirty_effects);
	}

	/**
	 * Returns `false` if the effect exists inside a boundary whose pending snippet is shown
	 * @returns {boolean}
	 */
	is_rendered() {
		return !this.is_pending && (!this.parent || this.parent.is_rendered());
	}

	has_pending_snippet() {
		return !!this.#props.pending;
	}

	/**
	 * @template T
	 * @param {() => T} fn
	 */
	#run(fn) {
		var previous_effect = active_effect;
		var previous_reaction = active_reaction;
		var previous_ctx = component_context;

		set_active_effect(this.#effect);
		set_active_reaction(this.#effect);
		set_component_context(this.#effect.ctx);

		try {
			Batch.ensure();
			return fn();
		} catch (e) {
			handle_error(e);
			return null;
		} finally {
			set_active_effect(previous_effect);
			set_active_reaction(previous_reaction);
			set_component_context(previous_ctx);
		}
	}

	/**
	 * Updates the pending count associated with the currently visible pending snippet,
	 * if any, such that we can replace the snippet with content once work is done
	 * @param {1 | -1} d
	 * @param {Batch} batch
	 */
	#update_pending_count(d, batch) {
		if (!this.has_pending_snippet()) {
			if (this.parent) {
				this.parent.#update_pending_count(d, batch);
			}

			// if there's no parent, we're in a scope with no pending snippet
			return;
		}

		this.#pending_count += d;

		if (this.#pending_count === 0) {
			this.#resolve(batch);

			if (this.#pending_effect) {
				pause_effect(this.#pending_effect, () => {
					this.#pending_effect = null;
				});
			}

			if (this.#offscreen_fragment) {
				this.#anchor.before(this.#offscreen_fragment);
				this.#offscreen_fragment = null;
			}
		}
	}

	/**
	 * Update the source that powers `$effect.pending()` inside this boundary,
	 * and controls when the current `pending` snippet (if any) is removed.
	 * Do not call from inside the class
	 * @param {1 | -1} d
	 * @param {Batch} batch
	 */
	update_pending_count(d, batch) {
		this.#update_pending_count(d, batch);

		this.#local_pending_count += d;

		if (!this.#effect_pending || this.#pending_count_update_queued) return;
		this.#pending_count_update_queued = true;

		queue_micro_task(() => {
			this.#pending_count_update_queued = false;
			if (this.#effect_pending) {
				internal_set(this.#effect_pending, this.#local_pending_count);
			}
		});
	}

	get_effect_pending() {
		this.#effect_pending_subscriber();
		return get(/** @type {Source<number>} */ (this.#effect_pending));
	}

	/** @param {unknown} error */
	error(error) {
		// If we have nothing to capture the error, or if we hit an error while
		// rendering the fallback, re-throw for another boundary to handle
		if (!this.#props.onerror && !this.#props.failed) {
			throw error;
		}

		if (current_batch?.is_fork) {
			if (this.#main_effect) current_batch.skip_effect(this.#main_effect);
			if (this.#pending_effect) current_batch.skip_effect(this.#pending_effect);
			if (this.#failed_effect) current_batch.skip_effect(this.#failed_effect);

			current_batch.oncommit(() => {
				this.#handle_error(error);
			});
		} else {
			this.#handle_error(error);
		}
	}

	/**
	 * @param {unknown} error
	 */
	#handle_error(error) {
		if (this.#main_effect) {
			destroy_effect(this.#main_effect);
			this.#main_effect = null;
		}

		if (this.#pending_effect) {
			destroy_effect(this.#pending_effect);
			this.#pending_effect = null;
		}

		if (this.#failed_effect) {
			destroy_effect(this.#failed_effect);
			this.#failed_effect = null;
		}

		var onerror = this.#props.onerror;
		let failed = this.#props.failed;
		var did_reset = false;
		var calling_on_error = false;

		const reset = () => {
			if (did_reset) {
				svelte_boundary_reset_noop();
				return;
			}

			did_reset = true;

			if (calling_on_error) {
				svelte_boundary_reset_onerror();
			}

			if (this.#failed_effect !== null) {
				pause_effect(this.#failed_effect, () => {
					this.#failed_effect = null;
				});
			}

			this.#run(() => {
				this.#render();
			});
		};

		/** @param {unknown} transformed_error */
		const handle_error_result = (transformed_error) => {
			try {
				calling_on_error = true;
				onerror?.(transformed_error, reset);
				calling_on_error = false;
			} catch (error) {
				invoke_error_boundary(error, this.#effect && this.#effect.parent);
			}

			if (failed) {
				this.#failed_effect = this.#run(() => {
					try {
						return branch(() => {
							// errors in `failed` snippets cause the boundary to error again
							// TODO Svelte 6: revisit this decision, most likely better to go to parent boundary instead
							var effect = /** @type {Effect} */ (active_effect);

							effect.b = this;
							effect.f |= BOUNDARY_EFFECT;

							failed(
								this.#anchor,
								() => transformed_error,
								() => reset
							);
						});
					} catch (error) {
						invoke_error_boundary(error, /** @type {Effect} */ (this.#effect.parent));
						return null;
					}
				});
			}
		};

		queue_micro_task(() => {
			// Run the error through the API-level transformError transform (e.g. SvelteKit's handleError)
			/** @type {unknown} */
			var result;
			try {
				result = this.transform_error(error);
			} catch (e) {
				invoke_error_boundary(e, this.#effect && this.#effect.parent);
				return;
			}

			if (
				result !== null &&
				typeof result === 'object' &&
				typeof (/** @type {any} */ (result).then) === 'function'
			) {
				// transformError returned a Promise — wait for it
				/** @type {any} */ (result).then(
					handle_error_result,
					/** @param {unknown} e */
					(e) => invoke_error_boundary(e, this.#effect && this.#effect.parent)
				);
			} else {
				// Synchronous result — handle immediately
				handle_error_result(result);
			}
		});
	}
}

/** @import { Blocker, Effect, Source, Value } from '#client' */

/**
 * @param {Blocker[]} blockers
 * @param {Array<() => any>} sync
 * @param {Array<() => Promise<any>>} async
 * @param {(values: Value[]) => any} fn
 */
function flatten(blockers, sync, async, fn) {
	const d = derived ;

	// Filter out already-settled blockers - no need to wait for them
	var pending = blockers.filter((b) => !b.settled);

	var deriveds = sync.map(d);

	if (async.length === 0 && pending.length === 0) {
		fn(deriveds);
		return;
	}

	var parent = /** @type {Effect} */ (active_effect);

	var restore = capture();
	var blocker_promise =
		pending.length === 1
			? pending[0].promise
			: pending.length > 1
				? Promise.all(pending.map((b) => b.promise))
				: null;

	/**
	 * @param {Source[]} async
	 */
	function finish(async) {
		if ((parent.f & DESTROYED) !== 0) {
			return;
		}

		restore();

		try {
			fn([...deriveds, ...async]);
		} catch (error) {
			invoke_error_boundary(error, parent);
		}

		unset_context();
	}

	var decrement_pending = increment_pending();

	// Fast path: blockers but no async expressions
	if (async.length === 0) {
		/** @type {Promise<any>} */ (blocker_promise).then(() => finish([])).finally(decrement_pending);
		return;
	}

	// Full path: has async expressions
	function run() {
		Promise.all(async.map((expression) => async_derived(expression)))
			.then(finish)
			.catch((error) => invoke_error_boundary(error, parent))
			.finally(decrement_pending);
	}

	if (blocker_promise) {
		blocker_promise.then(() => {
			restore();
			run();
			unset_context();
		});
	} else {
		run();
	}
}

/**
 * Captures the current effect context so that we can restore it after
 * some asynchronous work has happened (so that e.g. `await a + b`
 * causes `b` to be registered as a dependency).
 */
function capture() {
	var previous_effect = /** @type {Effect} */ (active_effect);
	var previous_reaction = active_reaction;
	var previous_component_context = component_context;
	var previous_batch = /** @type {Batch} */ (current_batch);

	return function restore(activate_batch = true) {
		set_active_effect(previous_effect);
		set_active_reaction(previous_reaction);
		set_component_context(previous_component_context);

		if (activate_batch && (previous_effect.f & DESTROYED) === 0) {
			// TODO we only need optional chaining here because `{#await ...}` blocks
			// are anomalous. Once we retire them we can get rid of it
			previous_batch?.activate();
			previous_batch?.apply();
		}
	};
}

function unset_context(deactivate_batch = true) {
	set_active_effect(null);
	set_active_reaction(null);
	set_component_context(null);
	if (deactivate_batch) current_batch?.deactivate();
}

/**
 * @returns {(skip?: boolean) => void}
 */
function increment_pending() {
	var effect = /** @type {Effect} */ (active_effect);
	var boundary = effect.b; // undefined if called outside the render tree, e.g. a standalone $effect.root
	var batch = /** @type {Batch} */ (current_batch);
	var blocking = !!boundary?.is_rendered();

	boundary?.update_pending_count(1, batch);
	batch.increment(blocking, effect);

	return () => {
		boundary?.update_pending_count(-1, batch);
		batch.decrement(blocking, effect);
	};
}

/** @import { Derived, Effect, Reaction, Source, Value } from '#client' */
/** @import { Batch } from './batch.js'; */
/** @import { Boundary } from '../dom/blocks/boundary.js'; */

/**
 * @template V
 * @param {() => V} fn
 * @returns {Derived<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
function derived(fn) {
	var flags = DERIVED | DIRTY;

	if (active_effect !== null) {
		// Since deriveds are evaluated lazily, any effects created inside them are
		// created too late to ensure that the parent effect is added to the tree
		active_effect.f |= EFFECT_PRESERVED;
	}

	/** @type {Derived<V>} */
	const signal = {
		ctx: component_context,
		deps: null,
		effects: null,
		equals,
		f: flags,
		fn,
		reactions: null,
		rv: 0,
		v: /** @type {V} */ (UNINITIALIZED),
		wv: 0,
		parent: active_effect,
		ac: null
	};

	return signal;
}

const OBSOLETE = Symbol('obsolete');

/**
 * @template V
 * @param {() => V | Promise<V>} fn
 * @param {string} [label]
 * @param {string} [location] If provided, print a warning if the value is not read immediately after update
 * @returns {Promise<Source<V>>}
 */
/*#__NO_SIDE_EFFECTS__*/
function async_derived(fn, label, location) {
	let parent = /** @type {Effect | null} */ (active_effect);

	if (parent === null) {
		async_derived_orphan();
	}

	var promise = /** @type {Promise<V>} */ (/** @type {unknown} */ (undefined));
	var signal = source(/** @type {V} */ (UNINITIALIZED));

	// only suspend in async deriveds created on initialisation
	var should_suspend = !active_reaction;

	/** @type {Set<ReturnType<typeof deferred<V>>>} */
	var deferreds = new Set();

	async_effect(() => {
		var effect = /** @type {Effect} */ (active_effect);

		/** @type {ReturnType<typeof deferred<V>>} */
		var d = deferred();
		promise = d.promise;

		try {
			// If this code is changed at some point, make sure to still access the then property
			// of fn() to read any signals it might access, so that we track them as dependencies.
			// We call `unset_context` to undo any `save` calls that happen inside `fn()`
			Promise.resolve(fn())
				.then(d.resolve, (e) => {
					// if the promise was rejected by the user, via `getAbortSignal`, then
					// wait for a subsequent resolution instead of flushing the batch
					if (e !== STALE_REACTION) d.reject(e);
				})
				.finally(unset_context);
		} catch (error) {
			d.reject(error);
			unset_context();
		}

		var batch = /** @type {Batch} */ (current_batch);

		if (should_suspend) {
			// we only increment the batch's pending state for updates, not creation, otherwise
			// we will decrement to zero before the work that depends on this promise (e.g. a
			// template effect) has initialized, causing the batch to resolve prematurely
			if ((effect.f & REACTION_RAN) !== 0) {
				var decrement_pending = increment_pending();
			}

			if (
				// boundary can be null if the async derived is inside an $effect.root not connected to the component render tree
				parent.b?.is_rendered()
			) {
				batch.async_deriveds.get(effect)?.reject(OBSOLETE);
			} else {
				// While the boundary is still showing pending, a new run supersedes all older in-flight runs
				// for this async expression. Cancel eagerly so resolution cannot commit stale values.
				for (const d of deferreds.values()) {
					d.reject(OBSOLETE);
				}
			}

			deferreds.add(d);
			batch.async_deriveds.set(effect, d);
		}

		/**
		 * @param {any} value
		 * @param {unknown} error
		 */
		const handler = (value, error = undefined) => {

			decrement_pending?.();
			deferreds.delete(d);

			if (error === OBSOLETE) return;

			batch.activate();

			if (error) {
				signal.f |= ERROR_VALUE;

				// @ts-expect-error the error is the wrong type, but we don't care
				internal_set(signal, error);
			} else {
				if ((signal.f & ERROR_VALUE) !== 0) {
					signal.f ^= ERROR_VALUE;
				}

				internal_set(signal, value);
			}

			batch.deactivate();
		};

		d.promise.then(handler, (e) => handler(null, e || 'unknown'));
	});

	teardown(() => {
		for (const d of deferreds) {
			d.reject(OBSOLETE);
		}
	});

	return new Promise((fulfil) => {
		/** @param {Promise<V>} p */
		function next(p) {
			function go() {
				if (p === promise) {
					fulfil(signal);
				} else {
					// if the effect re-runs before the initial promise
					// resolves, delay resolution until we have a value
					next(promise);
				}
			}

			p.then(go, go);
		}

		next(promise);
	});
}

/**
 * @template V
 * @param {() => V} fn
 * @returns {Derived<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
function user_derived(fn) {
	const d = derived(fn);

	push_reaction_value(d);

	return d;
}

/**
 * @template V
 * @param {() => V} fn
 * @returns {Derived<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
function derived_safe_equal(fn) {
	const signal = derived(fn);
	signal.equals = safe_equals;
	return signal;
}

/**
 * @param {Derived} derived
 * @returns {void}
 */
function destroy_derived_effects(derived) {
	var effects = derived.effects;

	if (effects !== null) {
		derived.effects = null;

		for (var i = 0; i < effects.length; i += 1) {
			destroy_effect(/** @type {Effect} */ (effects[i]));
		}
	}
}

/**
 * @template T
 * @param {Derived} derived
 * @returns {T}
 */
function execute_derived(derived) {
	var value;
	var prev_active_effect = active_effect;
	var parent = derived.parent;

	if (
		!is_destroying_effect &&
		parent !== null &&
		derived.v !== UNINITIALIZED && // if it was never evaluated before, it's guaranteed to fail downstream, so we try to execute instead
		(parent.f & (DESTROYED | INERT)) !== 0
	) {
		derived_inert();

		return derived.v;
	}

	set_active_effect(parent);

	{
		try {
			derived.f &= ~WAS_MARKED;
			destroy_derived_effects(derived);
			value = update_reaction(derived);
		} finally {
			set_active_effect(prev_active_effect);
		}
	}

	return value;
}

/**
 * @param {Derived} derived
 * @returns {void}
 */
function update_derived(derived) {
	var value = execute_derived(derived);

	if (!derived.equals(value)) {
		derived.wv = increment_write_version();

		// in a fork, we don't update the underlying value, just `batch_values`.
		// the underlying value will be updated when the fork is committed.
		// otherwise, the next time we get here after a 'real world' state
		// change, `derived.equals` may incorrectly return `true`
		if (!current_batch?.is_fork || derived.deps === null) {
			if (current_batch !== null) {
				// We also write to previous_batch because if it exists, it is a sign that we're
				// currently in the process of flushing effects. These updates to deriveds may belong
				// to the previous batch, not the new one (which can already exist if an earlier
				// effect wrote to a source). This can cause bugs when running batch.#commit() later,
				// but not adding it to current_batch can, too, so we add it to both.
				// See https://github.com/sveltejs/svelte/pull/18117 for more details.
				current_batch.capture(derived, value, true);
				previous_batch?.capture(derived, value, true);
			} else {
				derived.v = value;
			}

			// deriveds without dependencies should never be recomputed
			if (derived.deps === null) {
				set_signal_status(derived, CLEAN);
				return;
			}
		}
	}

	// don't mark derived clean if we're reading it inside a
	// cleanup function, or it will cache a stale value
	if (is_destroying_effect) {
		return;
	}

	// During time traveling we don't want to reset the status so that
	// traversal of the graph in the other batches still happens
	if (batch_values !== null) {
		// only cache the value if we're in a tracking context, otherwise we won't
		// clear the cache in `mark_reactions` when dependencies are updated
		if (effect_tracking() || current_batch?.is_fork) {
			batch_values.set(derived, value);
		}
	} else {
		update_derived_status(derived);
	}
}

/**
 * @param {Derived} derived
 */
function freeze_derived_effects(derived) {
	if (derived.effects === null) return;

	for (const e of derived.effects) {
		// if the effect has a teardown function or abort signal, call it
		if (e.teardown || e.ac) {
			e.teardown?.();
			e.ac?.abort(STALE_REACTION);

			// make it a noop so it doesn't get called again if the derived
			// is unfrozen. we don't set it to `null`, because the existence
			// of a teardown function is what determines whether the
			// effect runs again during unfreezing (but not for teardown-only effects)
			if (e.fn !== null) e.teardown = noop;
			e.ac = null;

			remove_reactions(e, 0);
			destroy_effect_children(e);
		}
	}
}

/**
 * @param {Derived} derived
 */
function unfreeze_derived_effects(derived) {
	if (derived.effects === null) return;

	for (const e of derived.effects) {
		// if the effect was previously frozen — indicated by the presence
		// of a teardown function — unfreeze it
		if (e.teardown && e.fn !== null) {
			update_effect(e);
		}
	}
}

/** @import { Fork } from 'svelte' */
/** @import { Derived, Effect, Reaction, Source, Value } from '#client' */

/** @type {Batch | null} */
let first_batch = null;

/** @type {Batch | null} */
let last_batch = null;

/** @type {Batch | null} */
let current_batch = null;

/**
 * This is needed to avoid overwriting inputs
 * @type {Batch | null}
 */
let previous_batch = null;

/**
 * When time travelling (i.e. working in one batch, while other batches
 * still have ongoing work), we ignore the real values of affected
 * signals in favour of their values within the batch
 * @type {Map<Value, any> | null}
 */
let batch_values = null;

/** @type {Effect | null} */
let last_scheduled_effect = null;
let is_processing = false;

/**
 * During traversal, this is an array. Newly created effects are (if not immediately
 * executed) pushed to this array, rather than going through the scheduling
 * rigamarole that would cause another turn of the flush loop.
 * @type {Effect[] | null}
 */
let collected_effects = null;

/**
 * An array of effects that are marked during traversal as a result of a `set`
 * (not `internal_set`) call. These will be added to the next batch and
 * trigger another `batch.process()`
 * @type {Effect[] | null}
 * @deprecated when we get rid of legacy mode and stores, we can get rid of this
 */
let legacy_updates = null;

var flush_count = 0;

/** @type {Set<Value>} */
var source_stacks = new Set();

let uid = 1;

class Batch {
	id = uid++;

	/** True as soon as `#process` was called */
	#started = false;

	linked = true;

	/** @type {Batch | null} */
	#prev = null;

	/** @type {Batch | null} */
	#next = null;

	/** @type {Map<Effect, ReturnType<typeof deferred<any>>>} */
	async_deriveds = new Map();

	/**
	 * The current values of any signals that are updated in this batch.
	 * Tuple format: [value, is_derived] (note: is_derived is false for deriveds, too, if they were overridden via assignment)
	 * They keys of this map are identical to `this.#previous`
	 * @type {Map<Value, [any, boolean]>}
	 */
	current = new Map();

	/**
	 * The values of any signals (sources and deriveds) that are updated in this batch _before_ those updates took place.
	 * They keys of this map are identical to `this.#current`
	 * @type {Map<Value, any>}
	 */
	previous = new Map();

	/**
	 * When the batch is committed (and the DOM is updated), we need to remove old branches
	 * and append new ones by calling the functions added inside (if/each/key/etc) blocks
	 * @type {Set<(batch: Batch) => void>}
	 */
	#commit_callbacks = new Set();

	/**
	 * If a fork is discarded, we need to destroy any effects that are no longer needed
	 * @type {Set<(batch: Batch) => void>}
	 */
	#discard_callbacks = new Set();

	/**
	 * The number of async effects that are currently in flight
	 */
	#pending = 0;

	/**
	 * Async effects that are currently in flight, _not_ inside a pending boundary
	 * @type {Map<Effect, number>}
	 */
	#blocking_pending = new Map();

	/**
	 * A deferred that resolves when the batch is committed, used with `settled()`
	 * TODO replace with Promise.withResolvers once supported widely enough
	 * @type {{ promise: Promise<void>, resolve: (value?: any) => void, reject: (reason: unknown) => void } | null}
	 */
	#deferred = null;

	/**
	 * The root effects that need to be flushed
	 * @type {Effect[]}
	 */
	#roots = [];

	/**
	 * Effects created while this batch was active.
	 * @type {Effect[]}
	 */
	#new_effects = [];

	/**
	 * Deferred effects (which run after async work has completed) that are DIRTY
	 * @type {Set<Effect>}
	 */
	#dirty_effects = new Set();

	/**
	 * Deferred effects that are MAYBE_DIRTY
	 * @type {Set<Effect>}
	 */
	#maybe_dirty_effects = new Set();

	/**
	 * A map of branches that still exist, but will be destroyed when this batch
	 * is committed — we skip over these during `process`.
	 * The value contains child effects that were dirty/maybe_dirty before being reset,
	 * so they can be rescheduled if the branch survives.
	 * @type {Map<Effect, { d: Effect[], m: Effect[] }>}
	 */
	#skipped_branches = new Map();

	/**
	 * Inverse of #skipped_branches which we need to tell prior batches to unskip them when committing
	 * @type {Set<Effect>}
	 */
	#unskipped_branches = new Set();

	is_fork = false;

	#decrement_queued = false;

	constructor() {
		// link batch
		if (last_batch === null) {
			first_batch = last_batch = this;
		} else {
			last_batch.#next = this;
			this.#prev = last_batch;
		}

		last_batch = this;
	}

	#is_deferred() {
		if (this.is_fork) return true;

		for (const effect of this.#blocking_pending.keys()) {
			var e = effect;
			var skipped = false;

			while (e.parent !== null) {
				if (this.#skipped_branches.has(e)) {
					skipped = true;
					break;
				}

				e = e.parent;
			}

			if (!skipped) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Add an effect to the #skipped_branches map and reset its children
	 * @param {Effect} effect
	 */
	skip_effect(effect) {
		if (!this.#skipped_branches.has(effect)) {
			this.#skipped_branches.set(effect, { d: [], m: [] });
		}
		this.#unskipped_branches.delete(effect);
	}

	/**
	 * Remove an effect from the #skipped_branches map and reschedule
	 * any tracked dirty/maybe_dirty child effects
	 * @param {Effect} effect
	 * @param {(e: Effect) => void} callback
	 */
	unskip_effect(effect, callback = (e) => this.schedule(e)) {
		var tracked = this.#skipped_branches.get(effect);
		if (tracked) {
			this.#skipped_branches.delete(effect);

			for (var e of tracked.d) {
				set_signal_status(e, DIRTY);
				callback(e);
			}

			for (e of tracked.m) {
				set_signal_status(e, MAYBE_DIRTY);
				callback(e);
			}
		}
		this.#unskipped_branches.add(effect);
	}

	#process() {
		this.#started = true;

		if (flush_count++ > 1000) {
			this.#unlink();
			infinite_loop_guard();
		}

		// We always reschedule previously-deferred effects, not just when
		// #is_deferred() is true, because traversing the tree could make
		// an if block that contains the last blocking pending effect falsy,
		// causing the block to no longer be deferred.
		for (const e of this.#dirty_effects) {
			this.#maybe_dirty_effects.delete(e);
			set_signal_status(e, DIRTY);
			this.schedule(e);
		}

		for (const e of this.#maybe_dirty_effects) {
			set_signal_status(e, MAYBE_DIRTY);
			this.schedule(e);
		}

		const roots = this.#roots;
		this.#roots = [];

		this.apply();

		/** @type {Effect[]} */
		var effects = (collected_effects = []);

		/** @type {Effect[]} */
		var render_effects = [];

		/**
		 * @type {Effect[]}
		 * @deprecated when we get rid of legacy mode and stores, we can get rid of this
		 */
		var updates = (legacy_updates = []);

		for (const root of roots) {
			try {
				this.#traverse(root, effects, render_effects);
			} catch (e) {
				reset_all(root);
				// If there's no async work left, this branch is now dead and needs
				// to be discarded to not become a zombie that is never cleaned up.
				// See https://github.com/sveltejs/svelte/issues/18221#issuecomment-4497918414
				// for a (non-minimal) reproduction that demonstrates a case where this is necessary
				// to not get follow-up false-positives via "batch has scheduled roots" invariant errors.
				if (!this.#is_deferred()) this.discard();
				throw e;
			}
		}

		// any writes should take effect in a subsequent batch
		current_batch = null;

		if (updates.length > 0) {
			var batch = Batch.ensure();
			for (const e of updates) {
				batch.schedule(e);
			}
		}

		collected_effects = null;
		legacy_updates = null;

		// if the batch has outstanding pending work, stash effects and bail
		if (this.#is_deferred()) {
			this.#defer_effects(render_effects);
			this.#defer_effects(effects);

			for (const [e, t] of this.#skipped_branches) {
				reset_branch(e, t);
			}

			if (updates.length > 0) {
				/** @type {Batch} */ (/** @type {unknown} */ (current_batch)).#process();
			}

			return;
		}

		const earlier_batch = this.#find_earlier_batch();

		if (earlier_batch) {
			// If this batch collected deferred effects during traversal, they still need
			// to run after being merged into the earlier batch.
			this.#defer_effects(render_effects);
			this.#defer_effects(effects);
			earlier_batch.#merge(this);
			return;
		}

		// clear effects. Those that are still needed will be rescheduled through unskipping the skipped branches.
		this.#dirty_effects.clear();
		this.#maybe_dirty_effects.clear();

		// append/remove branches
		for (const fn of this.#commit_callbacks) fn(this);
		this.#commit_callbacks.clear();

		previous_batch = this;
		flush_queued_effects(render_effects);
		flush_queued_effects(effects);
		previous_batch = null;

		this.#deferred?.resolve();

		var next_batch = /** @type {Batch | null} */ (/** @type {unknown} */ (current_batch));

		if (this.#pending === 0 && (this.#roots.length === 0 || next_batch !== null)) {
			this.#unlink();
		}

		// Edge case: During traversal new branches might create effects that run immediately and set state,
		// causing an effect and therefore a root to be scheduled again. We need to traverse the current batch
		// once more in that case - most of the time this will just clean up dirty branches.
		if (this.#roots.length > 0) {
			if (next_batch !== null) {
				const batch = next_batch;
				batch.#roots.push(...this.#roots.filter((r) => !batch.#roots.includes(r)));
			} else {
				next_batch = this;
			}
		}

		if (next_batch !== null) {
			next_batch.#process();
		}
	}

	/**
	 * Traverse the effect tree, executing effects or stashing
	 * them for later execution as appropriate
	 * @param {Effect} root
	 * @param {Effect[]} effects
	 * @param {Effect[]} render_effects
	 */
	#traverse(root, effects, render_effects) {
		root.f ^= CLEAN;

		var effect = root.first;

		while (effect !== null) {
			var flags = effect.f;
			var is_branch = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) !== 0;
			var is_skippable_branch = is_branch && (flags & CLEAN) !== 0;

			var skip = is_skippable_branch || (flags & INERT) !== 0 || this.#skipped_branches.has(effect);

			if (!skip && effect.fn !== null) {
				if (is_branch) {
					effect.f ^= CLEAN;
				} else if ((flags & EFFECT) !== 0) {
					effects.push(effect);
				} else if (is_dirty(effect)) {
					if ((flags & BLOCK_EFFECT) !== 0) this.#maybe_dirty_effects.add(effect);
					update_effect(effect);
				}

				var child = effect.first;

				if (child !== null) {
					effect = child;
					continue;
				}
			}

			while (effect !== null) {
				var next = effect.next;

				if (next !== null) {
					effect = next;
					break;
				}

				effect = effect.parent;
			}
		}
	}

	#find_earlier_batch() {
		var batch = this.#prev;

		while (batch !== null) {
			if (!batch.is_fork) {
				// if the batches are connected, break
				for (const [value, [, is_derived]] of this.current) {
					if (batch.current.has(value) && !is_derived) {
						return batch;
					}
				}
			}

			batch = batch.#prev;
		}

		return null;
	}

	/**
	 * @param {Batch} batch
	 */
	#merge(batch) {
		for (const [source, value] of batch.current) {
			if (!this.previous.has(source) && batch.previous.has(source)) {
				this.previous.set(source, batch.previous.get(source));
			}

			this.current.set(source, value);
		}

		for (const [effect, deferred] of batch.async_deriveds) {
			const d = this.async_deriveds.get(effect);
			if (d) deferred.promise.then(d.resolve).catch(d.reject);
		}

		// Clear them or else those that are still pending might get rejected on discard (after merged-into batch is done).
		// This can happen when batch Y merged into X and Y has a pending boundary and therefore still-pending async deriveds inside.
		batch.async_deriveds.clear();

		// Mark is not guaranteed not touch these, so we transfer them
		this.transfer_effects(batch.#dirty_effects, batch.#maybe_dirty_effects);

		/**
		 * mark all effects that depend on `batch.current`, except the
		 * async effects that we just resolved (TODO unless they depend
		 * on values in this batch that are NOT in the later batch?).
		 * Through this we also will populate the correct #skipped_branches,
		 * oncommit callbacks etc, so we don't need to merge them separately.
		 * @param {Value} value
		 */
		const mark = (value) => {
			var reactions = value.reactions;
			if (reactions === null) return;

			for (const reaction of reactions) {
				var flags = reaction.f;

				if ((flags & DERIVED) !== 0) {
					mark(/** @type {Derived} */ (reaction));
				} else {
					var effect = /** @type {Effect} */ (reaction);

					if (flags & (ASYNC | BLOCK_EFFECT) && !this.async_deriveds.has(effect)) {
						this.#maybe_dirty_effects.delete(effect);
						set_signal_status(effect, DIRTY);
						this.schedule(effect);
					}
				}
			}
		};

		for (const source of this.current.keys()) {
			mark(source);
		}

		this.oncommit(() => batch.discard());
		batch.#unlink();

		current_batch = this;
		this.#process();
	}

	/**
	 * @param {Effect[]} effects
	 */
	#defer_effects(effects) {
		for (var i = 0; i < effects.length; i += 1) {
			defer_effect(effects[i], this.#dirty_effects, this.#maybe_dirty_effects);
		}
	}

	/**
	 * Associate a change to a given source with the current
	 * batch, noting its previous and current values
	 * @param {Value} source
	 * @param {any} value
	 * @param {boolean} [is_derived]
	 */
	capture(source, value, is_derived = false) {
		if (source.v !== UNINITIALIZED && !this.previous.has(source)) {
			this.previous.set(source, source.v);
		}

		// Don't save errors in `batch_values`, or they won't be thrown in `runtime.js#get`
		if ((source.f & ERROR_VALUE) === 0) {
			this.current.set(source, [value, is_derived]);
			batch_values?.set(source, value);
		}

		if (!this.is_fork) {
			source.v = value;
		}
	}

	activate() {
		current_batch = this;
	}

	deactivate() {
		current_batch = null;
		batch_values = null;
	}

	flush() {
		try {
			if (DEV) ;

			is_processing = true;
			current_batch = this;

			this.#process();
		} finally {
			flush_count = 0;
			last_scheduled_effect = null;
			collected_effects = null;
			legacy_updates = null;
			is_processing = false;

			current_batch = null;
			batch_values = null;

			old_values.clear();
		}
	}

	discard() {
		for (const fn of this.#discard_callbacks) fn(this);
		this.#discard_callbacks.clear();

		for (const deferred of this.async_deriveds.values()) {
			deferred.reject(OBSOLETE);
		}

		this.#unlink();
		this.#deferred?.resolve();
	}

	/**
	 * @param {Effect} effect
	 */
	register_created_effect(effect) {
		this.#new_effects.push(effect);
	}

	#commit() {
		// If there are other pending batches, they now need to be 'rebased' —
		// in other words, we re-run block/async effects with the newly
		// committed state, unless the batch in question has a more
		// recent value for a given source
		for (let batch = first_batch; batch !== null; batch = batch.#next) {
			var is_earlier = batch.id < this.id;

			/** @type {Source[]} */
			var sources = [];

			for (const [source, [value, is_derived]] of this.current) {
				if (batch.current.has(source)) {
					var batch_value = /** @type {[any, boolean]} */ (batch.current.get(source))[0]; // faster than destructuring

					if (is_earlier && value !== batch_value) {
						// bring the value up to date
						batch.current.set(source, [value, is_derived]);
					} else {
						// same value or later batch has more recent value,
						// no need to re-run these effects
						continue;
					}
				}

				sources.push(source);
			}

			if (is_earlier) {
				// TODO do we need to restart these in some cases, instead of
				// immediately resolving them? Likely not because of how this.apply() works.
				for (const [effect, deferred] of this.async_deriveds) {
					const d = batch.async_deriveds.get(effect);
					if (d) deferred.promise.then(d.resolve).catch(d.reject);
				}
			}

			var current = [...batch.current.keys()].filter(
				(source) => !(/** @type {[any, boolean]} */ (batch.current.get(source))[1])
			);

			// If not started yet or no sources to update (which is e.g. possible for the very first batch) then bail
			if (!batch.#started || current.length === 0) continue;

			// Re-run async/block effects that depend on distinct values changed in both batches (ignoring deriveds)
			var others = current.filter((source) => !this.current.has(source));

			if (others.length === 0) {
				if (is_earlier) {
					// this batch is now obsolete and can be discarded
					batch.discard();
				}
			} else if (sources.length > 0) {

				// A batch was unskipped in a later batch -> tell prior batches to unskip it, too
				if (is_earlier) {
					for (const unskipped of this.#unskipped_branches) {
						batch.unskip_effect(unskipped, (e) => {
							if ((e.f & (BLOCK_EFFECT | ASYNC)) !== 0) {
								batch.schedule(e);
							} else {
								batch.#defer_effects([e]);
							}
						});
					}
				}

				batch.activate();

				/** @type {Set<Value>} */
				var marked = new Set();

				/** @type {Map<Reaction, boolean>} */
				var checked = new Map();

				for (var source of sources) {
					mark_effects(source, others, marked, checked);
				}

				checked = new Map();
				var current_unequal = [...batch.current]
					.filter(([c, v1]) => {
						const v2 = this.current.get(c);
						if (!v2) return true;
						// Either their values are different or one is a derived but not the other
						return v2[0] !== v1[0] || v2[1] !== v1[1];
					})
					.map(([c]) => c);

				if (current_unequal.length > 0) {
					for (const effect of this.#new_effects) {
						if (
							(effect.f & (DESTROYED | INERT | EAGER_EFFECT)) === 0 &&
							depends_on(effect, current_unequal, checked)
						) {
							if ((effect.f & (ASYNC | BLOCK_EFFECT)) !== 0) {
								set_signal_status(effect, DIRTY);
								batch.schedule(effect);
							} else {
								batch.#dirty_effects.add(effect);
							}
						}
					}
				}

				// Only apply and traverse when we know we triggered async work with marking the effects
				// and know this won't run anyway right afterwards
				if (batch.#roots.length > 0 && !batch.#decrement_queued) {
					batch.apply();

					for (var root of batch.#roots) {
						batch.#traverse(root, [], []);
					}

					batch.#roots = [];
				}

				batch.deactivate();
			}
		}
	}

	/**
	 * @param {boolean} blocking
	 * @param {Effect} effect
	 */
	increment(blocking, effect) {
		this.#pending += 1;

		if (blocking) {
			let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;
			this.#blocking_pending.set(effect, blocking_pending_count + 1);
		}
	}

	/**
	 * @param {boolean} blocking
	 * @param {Effect} effect
	 */
	decrement(blocking, effect) {
		this.#pending -= 1;

		if (blocking) {
			let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;

			if (blocking_pending_count === 1) {
				this.#blocking_pending.delete(effect);
			} else {
				this.#blocking_pending.set(effect, blocking_pending_count - 1);
			}
		}

		if (this.#decrement_queued) return;
		this.#decrement_queued = true;

		queue_micro_task(() => {
			this.#decrement_queued = false;

			if (this.linked) {
				this.flush();
			}
		});
	}

	/**
	 * @param {Set<Effect>} dirty_effects
	 * @param {Set<Effect>} maybe_dirty_effects
	 */
	transfer_effects(dirty_effects, maybe_dirty_effects) {
		for (const e of dirty_effects) {
			this.#dirty_effects.add(e);
		}

		for (const e of maybe_dirty_effects) {
			this.#maybe_dirty_effects.add(e);
		}

		dirty_effects.clear();
		maybe_dirty_effects.clear();
	}

	/** @param {(batch: Batch) => void} fn */
	oncommit(fn) {
		this.#commit_callbacks.add(fn);
	}

	/** @param {(batch: Batch) => void} fn */
	ondiscard(fn) {
		this.#discard_callbacks.add(fn);
	}

	settled() {
		return (this.#deferred ??= deferred()).promise;
	}

	static ensure() {
		if (current_batch === null) {
			const batch = (current_batch = new Batch());

			if (!is_processing && true) {
				queue_micro_task(() => {
					if (!batch.#started) {
						batch.flush();
					}
				});
			}
		}

		return current_batch;
	}

	apply() {
		{
			batch_values = null;
			return;
		}
	}

	/**
	 *
	 * @param {Effect} effect
	 */
	schedule(effect) {
		last_scheduled_effect = effect;

		// defer render effects inside a pending boundary
		// TODO the `REACTION_RAN` check is only necessary because of legacy `$:` effects AFAICT — we can remove later
		if (
			effect.b?.is_pending &&
			(effect.f & (EFFECT | RENDER_EFFECT | MANAGED_EFFECT)) !== 0 &&
			(effect.f & REACTION_RAN) === 0
		) {
			effect.b.defer_effect(effect);
			return;
		}

		var e = effect;

		while (e.parent !== null) {
			e = e.parent;
			var flags = e.f;

			// if the effect is being scheduled because a parent (each/await/etc) block
			// updated an internal source, or because a branch is being unskipped,
			// bail out or we'll cause a second flush
			if (collected_effects !== null && e === active_effect) {

				// in sync mode, render effects run during traversal. in an extreme edge case
				// — namely that we're setting a value inside a derived read during traversal —
				// they can be made dirty after they have already been visited, in which
				// case we shouldn't bail out. we also shouldn't bail out if we're
				// updating a store inside a `$:`, since this might invalidate
				// effects that were already visited
				if (
					(active_reaction === null || (active_reaction.f & DERIVED) === 0) &&
					true
				) {
					return;
				}
			}

			if ((flags & (ROOT_EFFECT | BRANCH_EFFECT)) !== 0) {
				if ((flags & CLEAN) === 0) {
					// branch is already dirty, bail
					return;
				}

				e.f ^= CLEAN;
			}
		}

		this.#roots.push(e);
	}

	#unlink() {
		// #merge calls #unlink, discard later on does it again - prevent
		// running it multiple times to not corrupt the linked list
		if (!this.linked) return;

		var prev = this.#prev;
		var next = this.#next;

		if (prev === null) {
			first_batch = next;
		} else {
			prev.#next = next;
		}

		if (next === null) {
			last_batch = prev;
		} else {
			next.#prev = prev;
		}

		this.linked = false;
	}
}

function infinite_loop_guard() {

	try {
		effect_update_depth_exceeded();
	} catch (error) {

		// Best effort: invoke the boundary nearest the most recent
		// effect and hope that it's relevant to the infinite loop
		invoke_error_boundary(error, last_scheduled_effect);
	}
}

/** @type {Set<Effect> | null} */
let eager_block_effects = null;

/**
 * @param {Array<Effect>} effects
 * @returns {void}
 */
function flush_queued_effects(effects) {
	var length = effects.length;
	if (length === 0) return;

	var i = 0;

	while (i < length) {
		var effect = effects[i++];

		if ((effect.f & (DESTROYED | INERT)) === 0 && is_dirty(effect)) {
			eager_block_effects = new Set();

			update_effect(effect);

			// Effects with no dependencies or teardown do not get added to the effect tree.
			// Deferred effects (e.g. `$effect(...)`) _are_ added to the tree because we
			// don't know if we need to keep them until they are executed. Doing the check
			// here (rather than in `update_effect`) allows us to skip the work for
			// immediate effects.
			if (
				effect.deps === null &&
				effect.first === null &&
				effect.nodes === null &&
				effect.teardown === null &&
				effect.ac === null
			) {
				// remove this effect from the graph
				unlink_effect(effect);
			}

			// If update_effect() has a flushSync() in it, we may have flushed another flush_queued_effects(),
			// which already handled this logic and did set eager_block_effects to null.
			if (eager_block_effects?.size > 0) {
				old_values.clear();

				for (const e of eager_block_effects) {
					// Skip eager effects that have already been unmounted
					if ((e.f & (DESTROYED | INERT)) !== 0) continue;

					// Run effects in order from ancestor to descendant, else we could run into nullpointers
					/** @type {Effect[]} */
					const ordered_effects = [e];
					let ancestor = e.parent;
					while (ancestor !== null) {
						if (eager_block_effects.has(ancestor)) {
							eager_block_effects.delete(ancestor);
							ordered_effects.push(ancestor);
						}
						ancestor = ancestor.parent;
					}

					for (let j = ordered_effects.length - 1; j >= 0; j--) {
						const e = ordered_effects[j];
						// Skip eager effects that have already been unmounted
						if ((e.f & (DESTROYED | INERT)) !== 0) continue;
						update_effect(e);
					}
				}

				eager_block_effects.clear();
			}
		}
	}

	eager_block_effects = null;
}

/**
 * This is similar to `mark_reactions`, but it only marks async/block effects
 * depending on `value` and at least one of the other `sources`, so that
 * these effects can re-run after another batch has been committed
 * @param {Value} value
 * @param {Source[]} sources
 * @param {Set<Value>} marked
 * @param {Map<Reaction, boolean>} checked
 */
function mark_effects(value, sources, marked, checked) {
	if (marked.has(value)) return;
	marked.add(value);

	if (value.reactions !== null) {
		for (const reaction of value.reactions) {
			const flags = reaction.f;

			if ((flags & DERIVED) !== 0) {
				mark_effects(/** @type {Derived} */ (reaction), sources, marked, checked);
			} else if (
				(flags & (ASYNC | BLOCK_EFFECT)) !== 0 &&
				(flags & DIRTY) === 0 &&
				depends_on(reaction, sources, checked)
			) {
				set_signal_status(reaction, DIRTY);
				schedule_effect(/** @type {Effect} */ (reaction));
			}
		}
	}
}

/**
 * @param {Reaction} reaction
 * @param {Source[]} sources
 * @param {Map<Reaction, boolean>} checked
 */
function depends_on(reaction, sources, checked) {
	const depends = checked.get(reaction);
	if (depends !== undefined) return depends;

	if (reaction.deps !== null) {
		for (const dep of reaction.deps) {
			if (includes.call(sources, dep)) {
				return true;
			}

			if ((dep.f & DERIVED) !== 0 && depends_on(/** @type {Derived} */ (dep), sources, checked)) {
				checked.set(/** @type {Derived} */ (dep), true);
				return true;
			}
		}
	}

	checked.set(reaction, false);

	return false;
}

/**
 * @param {Effect} effect
 * @returns {void}
 */
function schedule_effect(effect) {
	/** @type {Batch} */ (current_batch).schedule(effect);
}

/**
 * Mark all the effects inside a skipped branch CLEAN, so that
 * they can be correctly rescheduled later. Tracks dirty and maybe_dirty
 * effects so they can be rescheduled if the branch survives.
 * @param {Effect} effect
 * @param {{ d: Effect[], m: Effect[] }} tracked
 */
function reset_branch(effect, tracked) {
	// clean branch = nothing dirty inside, no need to traverse further
	if ((effect.f & BRANCH_EFFECT) !== 0 && (effect.f & CLEAN) !== 0) {
		return;
	}

	if ((effect.f & DIRTY) !== 0) {
		tracked.d.push(effect);
	} else if ((effect.f & MAYBE_DIRTY) !== 0) {
		tracked.m.push(effect);
	}

	set_signal_status(effect, CLEAN);

	var e = effect.first;
	while (e !== null) {
		reset_branch(e, tracked);
		e = e.next;
	}
}

/**
 * Mark an entire effect tree clean following an error
 * @param {Effect} effect
 */
function reset_all(effect) {
	set_signal_status(effect, CLEAN);

	var e = effect.first;
	while (e !== null) {
		reset_all(e);
		e = e.next;
	}
}

/** @import { Derived, Effect, Source, Value } from '#client' */

/** @type {Set<Effect>} */
let eager_effects = new Set();

/** @type {Map<Source, any>} */
const old_values = new Map();

let eager_effects_deferred = false;

/**
 * @template V
 * @param {V} v
 * @param {Error | null} [stack]
 * @returns {Source<V>}
 */
// TODO rename this to `state` throughout the codebase
function source(v, stack) {
	/** @type {Value} */
	var signal = {
		f: 0, // TODO ideally we could skip this altogether, but it causes type errors
		v,
		reactions: null,
		equals,
		rv: 0,
		wv: 0
	};

	return signal;
}

/**
 * @template V
 * @param {V} v
 * @param {Error | null} [stack]
 */
/*#__NO_SIDE_EFFECTS__*/
function state(v, stack) {
	const s = source(v);

	push_reaction_value(s);

	return s;
}

/**
 * @template V
 * @param {V} initial_value
 * @param {boolean} [immutable]
 * @returns {Source<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
function mutable_source(initial_value, immutable = false, trackable = true) {
	const s = source(initial_value);
	if (!immutable) {
		s.equals = safe_equals;
	}

	return s;
}

/**
 * @template V
 * @param {Source<V>} source
 * @param {V} value
 * @param {boolean} [should_proxy]
 * @returns {V}
 */
function set(source, value, should_proxy = false) {
	if (
		active_reaction !== null &&
		// since we are untracking the function inside `$inspect.with` we need to add this check
		// to ensure we error if state is set inside an inspect effect
		(!untracking || (active_reaction.f & EAGER_EFFECT) !== 0) &&
		is_runes() &&
		(active_reaction.f & (DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT)) !== 0 &&
		(current_sources === null || !current_sources.has(source))
	) {
		state_unsafe_mutation();
	}

	let new_value = should_proxy ? proxy(value) : value;

	return internal_set(source, new_value, legacy_updates);
}

/**
 * @template V
 * @param {Source<V>} source
 * @param {V} value
 * @param {Effect[] | null} [updated_during_traversal]
 * @returns {V}
 */
function internal_set(source, value, updated_during_traversal = null) {
	if (!source.equals(value)) {
		old_values.set(source, is_destroying_effect ? value : source.v);

		var batch = Batch.ensure();
		batch.capture(source, value);

		if ((source.f & DERIVED) !== 0) {
			const derived = /** @type {Derived} */ (source);

			// if we are assigning to a dirty derived we set it to clean/maybe dirty but we also eagerly execute it to track the dependencies
			if ((source.f & DIRTY) !== 0) {
				execute_derived(derived);
			}

			// During time traveling we don't want to reset the status so that
			// traversal of the graph in the other batches still happens
			if (batch_values === null) {
				update_derived_status(derived);
			}
		}

		source.wv = increment_write_version();

		// For debugging, in case you want to know which reactions are being scheduled:
		// log_reactions(source);
		mark_reactions(source, DIRTY, updated_during_traversal);

		// It's possible that the current reaction might not have up-to-date dependencies
		// whilst it's actively running. So in the case of ensuring it registers the reaction
		// properly for itself, we need to ensure the current effect actually gets
		// scheduled. i.e: `$effect(() => x++)`
		if (
			active_effect !== null &&
			(active_effect.f & CLEAN) !== 0 &&
			(active_effect.f & (BRANCH_EFFECT | ROOT_EFFECT)) === 0
		) {
			if (untracked_writes === null) {
				set_untracked_writes([source]);
			} else {
				untracked_writes.push(source);
			}
		}

		if (!batch.is_fork && eager_effects.size > 0 && !eager_effects_deferred) {
			flush_eager_effects();
		}
	}

	return value;
}

function flush_eager_effects() {
	eager_effects_deferred = false;

	for (const effect of eager_effects) {
		// Mark clean inspect-effects as maybe dirty and then check their dirtiness
		// instead of just updating the effects - this way we avoid overfiring.
		if ((effect.f & CLEAN) !== 0) {
			set_signal_status(effect, MAYBE_DIRTY);
		}

		let dirty;

		try {
			dirty = is_dirty(effect);
		} catch {
			// Dirty-checking can evaluate derived dependencies and throw in cases where
			// parent effects are about to destroy this eager effect. Run the effect so
			// its own error handling can deal with transient failures.
			dirty = true;
		}

		if (dirty) {
			update_effect(effect);
		}
	}

	eager_effects.clear();
}

/**
 * Silently (without using `get`) increment a source
 * @param {Source<number>} source
 */
function increment(source) {
	set(source, source.v + 1);
}

/**
 * @param {Value} signal
 * @param {number} status should be DIRTY or MAYBE_DIRTY
 * @param {Effect[] | null} updated_during_traversal
 * @returns {void}
 */
function mark_reactions(signal, status, updated_during_traversal) {
	var reactions = signal.reactions;
	if (reactions === null) return;
	var length = reactions.length;

	for (var i = 0; i < length; i++) {
		var reaction = reactions[i];
		var flags = reaction.f;

		var not_dirty = (flags & DIRTY) === 0;

		// don't set a DIRTY reaction to MAYBE_DIRTY
		if (not_dirty) {
			set_signal_status(reaction, status);
		}

		if ((flags & EAGER_EFFECT) !== 0) {
			// Eager effects need to run immediately:
			// - for $inspect so that the stack trace makes sense
			// - for $state.eager because they might be without an effect parent
			eager_effects.add(/** @type {Effect} */ (reaction));
		} else if ((flags & DERIVED) !== 0) {
			var derived = /** @type {Derived} */ (reaction);

			batch_values?.delete(derived);

			if ((flags & WAS_MARKED) === 0) {
				// Only connected deriveds being executed outside the update cycle can be reliably unmarked right away
				if (
					flags & CONNECTED &&
					(active_effect === null || (active_effect.f & REACTION_IS_UPDATING) === 0)
				) {
					reaction.f |= WAS_MARKED;
				}

				mark_reactions(derived, MAYBE_DIRTY, updated_during_traversal);
			}
		} else if (not_dirty) {
			var effect = /** @type {Effect} */ (reaction);

			if ((flags & BLOCK_EFFECT) !== 0 && eager_block_effects !== null) {
				eager_block_effects.add(effect);
			}

			if (updated_during_traversal !== null) {
				updated_during_traversal.push(effect);
			} else {
				schedule_effect(effect);
			}
		}
	}
}

/**
 * @param {HTMLElement} dom
 * @param {boolean} value
 * @returns {void}
 */
function autofocus(dom, value) {
	if (value) {
		const body = document.body;
		dom.autofocus = true;

		queue_micro_task(() => {
			if (document.activeElement === body) {
				dom.focus();
			}
		});
	}
}

/**
 * @template T
 * @param {() => T} fn
 */
function without_reactive_context(fn) {
	var previous_reaction = active_reaction;
	var previous_effect = active_effect;
	set_active_reaction(null);
	set_active_effect(null);
	try {
		return fn();
	} finally {
		set_active_reaction(previous_reaction);
		set_active_effect(previous_effect);
	}
}

/** @import { Derived, Effect, Reaction, Source, Value } from '#client' */

let is_updating_effect = false;

let is_destroying_effect = false;

/** @param {boolean} value */
function set_is_destroying_effect(value) {
	is_destroying_effect = value;
}

/** @type {null | Reaction} */
let active_reaction = null;

let untracking = false;

/** @param {null | Reaction} reaction */
function set_active_reaction(reaction) {
	active_reaction = reaction;
}

/** @type {null | Effect} */
let active_effect = null;

/** @param {null | Effect} effect */
function set_active_effect(effect) {
	active_effect = effect;
}

/**
 * When sources are created within a reaction, reading and writing
 * them within that reaction should not cause a re-run
 * @type {null | Set<Source>}
 */
let current_sources = null;

/** @param {Value} value */
function push_reaction_value(value) {
	if (active_reaction !== null && (true)) {
		(current_sources ??= new Set()).add(value);
	}
}

/**
 * The dependencies of the reaction that is currently being executed. In many cases,
 * the dependencies are unchanged between runs, and so this will be `null` unless
 * and until a new dependency is accessed — we track this via `skipped_deps`
 * @type {null | Value[]}
 */
let new_deps = null;

let skipped_deps = 0;

/**
 * Tracks writes that the effect it's executed in doesn't listen to yet,
 * so that the dependency can be added to the effect later on if it then reads it
 * @type {null | Source[]}
 */
let untracked_writes = null;

/** @param {null | Source[]} value */
function set_untracked_writes(value) {
	untracked_writes = value;
}

/**
 * @type {number} Used by sources and deriveds for handling updates.
 * Version starts from 1 so that unowned deriveds differentiate between a created effect and a run one for tracing
 **/
let write_version = 1;

/** @type {number} Used to version each read of a source of derived to avoid duplicating depedencies inside a reaction */
let read_version = 0;

let update_version = read_version;

/** @param {number} value */
function set_update_version(value) {
	update_version = value;
}

function increment_write_version() {
	return ++write_version;
}

/**
 * Determines whether a derived or effect is dirty.
 * If it is MAYBE_DIRTY, will set the status to CLEAN
 * @param {Reaction} reaction
 * @returns {boolean}
 */
function is_dirty(reaction) {
	var flags = reaction.f;

	if ((flags & DIRTY) !== 0) {
		return true;
	}

	if (flags & DERIVED) {
		reaction.f &= ~WAS_MARKED;
	}

	if ((flags & MAYBE_DIRTY) !== 0) {
		var dependencies = /** @type {Value[]} */ (reaction.deps);
		var length = dependencies.length;

		for (var i = 0; i < length; i++) {
			var dependency = dependencies[i];

			if (is_dirty(/** @type {Derived} */ (dependency))) {
				update_derived(/** @type {Derived} */ (dependency));
			}

			if (dependency.wv > reaction.wv) {
				return true;
			}
		}

		if (
			(flags & CONNECTED) !== 0 &&
			// During time traveling we don't want to reset the status so that
			// traversal of the graph in the other batches still happens
			batch_values === null
		) {
			set_signal_status(reaction, CLEAN);
		}
	}

	return false;
}

/**
 * @param {Value} signal
 * @param {Effect} effect
 * @param {boolean} [root]
 */
function schedule_possible_effect_self_invalidation(signal, effect, root = true) {
	var reactions = signal.reactions;
	if (reactions === null) return;

	if (current_sources !== null && current_sources.has(signal)) {
		return;
	}

	for (var i = 0; i < reactions.length; i++) {
		var reaction = reactions[i];

		if ((reaction.f & DERIVED) !== 0) {
			schedule_possible_effect_self_invalidation(/** @type {Derived} */ (reaction), effect, false);
		} else if (effect === reaction) {
			if (root) {
				set_signal_status(reaction, DIRTY);
			} else if ((reaction.f & CLEAN) !== 0) {
				set_signal_status(reaction, MAYBE_DIRTY);
			}
			schedule_effect(/** @type {Effect} */ (reaction));
		}
	}
}

/** @param {Reaction} reaction */
function update_reaction(reaction) {
	var previous_deps = new_deps;
	var previous_skipped_deps = skipped_deps;
	var previous_untracked_writes = untracked_writes;
	var previous_reaction = active_reaction;
	var previous_sources = current_sources;
	var previous_component_context = component_context;
	var previous_untracking = untracking;
	var previous_update_version = update_version;

	var flags = reaction.f;

	new_deps = /** @type {null | Value[]} */ (null);
	skipped_deps = 0;
	untracked_writes = null;
	active_reaction = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) === 0 ? reaction : null;

	current_sources = null;
	set_component_context(reaction.ctx);
	untracking = false;
	update_version = ++read_version;

	if (reaction.ac !== null) {
		without_reactive_context(() => {
			/** @type {AbortController} */ (reaction.ac).abort(STALE_REACTION);
		});

		reaction.ac = null;
	}

	try {
		reaction.f |= REACTION_IS_UPDATING;
		var fn = /** @type {Function} */ (reaction.fn);
		var result = fn();
		reaction.f |= REACTION_RAN;
		var deps = reaction.deps;

		// Don't remove reactions during fork;
		// they must remain for when fork is discarded
		var is_fork = current_batch?.is_fork;

		if (new_deps !== null) {
			var i;

			if (!is_fork) {
				remove_reactions(reaction, skipped_deps);
			}

			if (deps !== null && skipped_deps > 0) {
				deps.length = skipped_deps + new_deps.length;
				for (i = 0; i < new_deps.length; i++) {
					deps[skipped_deps + i] = new_deps[i];
				}
			} else {
				reaction.deps = deps = new_deps;
			}

			if (effect_tracking() && (reaction.f & CONNECTED) !== 0) {
				for (i = skipped_deps; i < deps.length; i++) {
					(deps[i].reactions ??= []).push(reaction);
				}
			}
		} else if (!is_fork && deps !== null && skipped_deps < deps.length) {
			remove_reactions(reaction, skipped_deps);
			deps.length = skipped_deps;
		}

		// If we're inside an effect and we have untracked writes, then we need to
		// ensure that if any of those untracked writes result in re-invalidation
		// of the current effect, then that happens accordingly
		if (
			is_runes() &&
			untracked_writes !== null &&
			!untracking &&
			deps !== null &&
			(reaction.f & (DERIVED | MAYBE_DIRTY | DIRTY)) === 0
		) {
			for (i = 0; i < /** @type {Source[]} */ (untracked_writes).length; i++) {
				schedule_possible_effect_self_invalidation(
					untracked_writes[i],
					/** @type {Effect} */ (reaction)
				);
			}
		}

		// If we are returning to an previous reaction then
		// we need to increment the read version to ensure that
		// any dependencies in this reaction aren't marked with
		// the same version
		if (previous_reaction !== null && previous_reaction !== reaction) {
			read_version++;

			// update the `rv` of the previous reaction's deps — both existing and new —
			// so that they are not added again
			if (previous_reaction.deps !== null) {
				for (let i = 0; i < previous_skipped_deps; i += 1) {
					previous_reaction.deps[i].rv = read_version;
				}
			}

			if (previous_deps !== null) {
				for (const dep of previous_deps) {
					dep.rv = read_version;
				}
			}

			if (untracked_writes !== null) {
				if (previous_untracked_writes === null) {
					previous_untracked_writes = untracked_writes;
				} else {
					previous_untracked_writes.push(.../** @type {Source[]} */ (untracked_writes));
				}
			}
		}

		if ((reaction.f & ERROR_VALUE) !== 0) {
			reaction.f ^= ERROR_VALUE;
		}

		return result;
	} catch (error) {
		return handle_error(error);
	} finally {
		reaction.f ^= REACTION_IS_UPDATING;
		new_deps = previous_deps;
		skipped_deps = previous_skipped_deps;
		untracked_writes = previous_untracked_writes;
		active_reaction = previous_reaction;
		current_sources = previous_sources;
		set_component_context(previous_component_context);
		untracking = previous_untracking;
		update_version = previous_update_version;
	}
}

/**
 * @template V
 * @param {Reaction} signal
 * @param {Value<V>} dependency
 * @returns {void}
 */
function remove_reaction(signal, dependency) {
	let reactions = dependency.reactions;
	if (reactions !== null) {
		var index = index_of.call(reactions, signal);
		if (index !== -1) {
			var new_length = reactions.length - 1;
			if (new_length === 0) {
				reactions = dependency.reactions = null;
			} else {
				// Swap with last element and then remove.
				reactions[index] = reactions[new_length];
				reactions.pop();
			}
		}
	}

	// If the derived has no reactions, then we can disconnect it from the graph,
	// allowing it to either reconnect in the future, or be GC'd by the VM.
	if (
		reactions === null &&
		(dependency.f & DERIVED) !== 0 &&
		// Destroying a child effect while updating a parent effect can cause a dependency to appear
		// to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
		// allows us to skip the expensive work of disconnecting and immediately reconnecting it
		(new_deps === null || !includes.call(new_deps, dependency))
	) {
		var derived = /** @type {Derived} */ (dependency);

		// If we are working with a derived that is owned by an effect, then mark it as being
		// disconnected and remove the mark flag, as it cannot be reliably removed otherwise
		if ((derived.f & CONNECTED) !== 0) {
			derived.f ^= CONNECTED;
			derived.f &= ~WAS_MARKED;
		}

		// In a fork it's possible that a derived is executed and gets reactions, then commits, but is
		// never re-executed. This is possible when the derived is only executed once in the context
		// of a new branch which happens before fork.commit() runs. In this case, the derived still has
		// UNINITIALIZED as its value, and then when it's loosing its reactions we need to ensure it stays
		// DIRTY so it is reexecuted once someone wants its value again.
		if (derived.v !== UNINITIALIZED) {
			update_derived_status(derived);
		}

		// freeze any effects inside this derived
		freeze_derived_effects(derived);

		// Disconnect any reactions owned by this reaction
		remove_reactions(derived, 0);
	}
}

/**
 * @param {Reaction} signal
 * @param {number} start_index
 * @returns {void}
 */
function remove_reactions(signal, start_index) {
	var dependencies = signal.deps;
	if (dependencies === null) return;

	for (var i = start_index; i < dependencies.length; i++) {
		remove_reaction(signal, dependencies[i]);
	}
}

/**
 * @param {Effect} effect
 * @returns {void}
 */
function update_effect(effect) {
	var flags = effect.f;

	if ((flags & DESTROYED) !== 0) {
		return;
	}

	set_signal_status(effect, CLEAN);

	var previous_effect = active_effect;
	var was_updating_effect = is_updating_effect;

	active_effect = effect;
	is_updating_effect = true;

	try {
		if ((flags & (BLOCK_EFFECT | MANAGED_EFFECT)) !== 0) {
			destroy_block_effect_children(effect);
		} else {
			destroy_effect_children(effect);
		}

		execute_effect_teardown(effect);
		var teardown = update_reaction(effect);
		effect.teardown = typeof teardown === 'function' ? teardown : null;
		effect.wv = write_version;

		// In DEV, increment versions of any sources that were written to during the effect,
		// so that they are correctly marked as dirty when the effect re-runs
		var dep; if (DEV && tracing_mode_flag && (effect.f & DIRTY) !== 0 && effect.deps !== null) ;
	} finally {
		is_updating_effect = was_updating_effect;
		active_effect = previous_effect;
	}
}

/**
 * @template V
 * @param {Value<V>} signal
 * @returns {V}
 */
function get(signal) {
	var flags = signal.f;
	var is_derived = (flags & DERIVED) !== 0;

	// Register the dependency on the current reaction signal.
	if (active_reaction !== null && !untracking) {
		// if we're in a derived that is being read inside an _async_ derived,
		// it's possible that the effect was already destroyed. In this case,
		// we don't add the dependency, because that would create a memory leak
		var destroyed = active_effect !== null && (active_effect.f & DESTROYED) !== 0;

		if (!destroyed && (current_sources === null || !current_sources.has(signal))) {
			var deps = active_reaction.deps;

			if ((active_reaction.f & REACTION_IS_UPDATING) !== 0) {
				// we're in the effect init/update cycle
				if (signal.rv < read_version) {
					signal.rv = read_version;

					// If the signal is accessing the same dependencies in the same
					// order as it did last time, increment `skipped_deps`
					// rather than updating `new_deps`, which creates GC cost
					if (new_deps === null && deps !== null && deps[skipped_deps] === signal) {
						skipped_deps++;
					} else if (new_deps === null) {
						new_deps = [signal];
					} else {
						new_deps.push(signal);
					}
				}
			} else {
				// We're adding a dependency outside the init/update cycle (i.e. after an `await`).
				// We have to deduplicate deps/reactions in this case or remove_reactions could
				// disconnect deps/reactions that are actually still in use (if skip_deps says
				// "disconnect all after this index" and some of the signals are also present in
				// list prior to the cutoff index, i.e. that should be kept).
				active_reaction.deps ??= [];
				if (!includes.call(active_reaction.deps, signal)) {
					active_reaction.deps.push(signal);
				}

				var reactions = signal.reactions;

				if (reactions === null) {
					signal.reactions = [active_reaction];
				} else if (!includes.call(reactions, active_reaction)) {
					reactions.push(active_reaction);
				}
			}
		}
	}

	if (is_destroying_effect && old_values.has(signal)) {
		return old_values.get(signal);
	}

	if (is_derived) {
		var derived = /** @type {Derived} */ (signal);

		if (is_destroying_effect) {
			var value = derived.v;

			// if the derived is dirty and has reactions, or depends on the values that just changed, re-execute
			// (a derived can be maybe_dirty due to the effect destroy removing its last reaction)
			if (
				((derived.f & CLEAN) === 0 && derived.reactions !== null) ||
				depends_on_old_values(derived)
			) {
				value = execute_derived(derived);
			}

			old_values.set(derived, value);

			return value;
		}

		// connect disconnected deriveds if we are reading them inside an effect,
		// or inside another derived that is already connected
		var should_connect =
			(derived.f & CONNECTED) === 0 &&
			!untracking &&
			active_reaction !== null &&
			(is_updating_effect || (active_reaction.f & CONNECTED) !== 0);

		var is_new = (derived.f & REACTION_RAN) === 0;

		if (is_dirty(derived)) {
			if (should_connect) {
				// set the flag before `update_derived`, so that the derived
				// is added as a reaction to its dependencies
				derived.f |= CONNECTED;
			}

			update_derived(derived);
		}

		if (should_connect && !is_new) {
			unfreeze_derived_effects(derived);
			reconnect(derived);
		}
	}

	if (batch_values?.has(signal)) {
		return batch_values.get(signal);
	}

	if ((signal.f & ERROR_VALUE) !== 0) {
		throw signal.v;
	}

	return signal.v;
}

/**
 * (Re)connect a disconnected derived, so that it is notified
 * of changes in `mark_reactions`
 * @param {Derived} derived
 */
function reconnect(derived) {
	derived.f |= CONNECTED;

	if (derived.deps === null) return;

	for (const dep of derived.deps) {
		(dep.reactions ??= []).push(derived);

		if ((dep.f & DERIVED) !== 0 && (dep.f & CONNECTED) === 0) {
			unfreeze_derived_effects(/** @type {Derived} */ (dep));
			reconnect(/** @type {Derived} */ (dep));
		}
	}
}

/** @param {Derived} derived */
function depends_on_old_values(derived) {
	if (derived.v === UNINITIALIZED) return true; // we don't know, so assume the worst
	if (derived.deps === null) return false;

	for (const dep of derived.deps) {
		if (old_values.has(dep)) {
			return true;
		}

		if ((dep.f & DERIVED) !== 0 && depends_on_old_values(/** @type {Derived} */ (dep))) {
			return true;
		}
	}

	return false;
}

/**
 * When used inside a [`$derived`](https://svelte.dev/docs/svelte/$derived) or [`$effect`](https://svelte.dev/docs/svelte/$effect),
 * any state read inside `fn` will not be treated as a dependency.
 *
 * ```ts
 * $effect(() => {
 *   // this will run when `data` changes, but not when `time` changes
 *   save(data, {
 *     timestamp: untrack(() => time)
 *   });
 * });
 * ```
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function untrack(fn) {
	var previous_untracking = untracking;
	try {
		untracking = true;
		return fn();
	} finally {
		untracking = previous_untracking;
	}
}

/** @import { Blocker, ComponentContext, ComponentContextLegacy, Derived, Effect, TemplateNode, TransitionManager } from '#client' */

/**
 * @param {'$effect' | '$effect.pre' | '$inspect'} rune
 */
function validate_effect(rune) {
	if (active_effect === null) {
		if (active_reaction === null) {
			effect_orphan();
		}

		effect_in_unowned_derived();
	}

	if (is_destroying_effect) {
		effect_in_teardown();
	}
}

/**
 * @param {Effect} effect
 * @param {Effect} parent_effect
 */
function push_effect(effect, parent_effect) {
	var parent_last = parent_effect.last;
	if (parent_last === null) {
		parent_effect.last = parent_effect.first = effect;
	} else {
		parent_last.next = effect;
		effect.prev = parent_last;
		parent_effect.last = effect;
	}
}

/**
 * @param {number} type
 * @param {null | (() => void | (() => void))} fn
 * @returns {Effect}
 */
function create_effect(type, fn) {
	var parent = active_effect;

	if (parent !== null && (parent.f & INERT) !== 0) {
		type |= INERT;
	}

	/** @type {Effect} */
	var effect = {
		ctx: component_context,
		deps: null,
		nodes: null,
		f: type | DIRTY | CONNECTED,
		first: null,
		fn,
		last: null,
		next: null,
		parent,
		b: parent && parent.b,
		prev: null,
		teardown: null,
		wv: 0,
		ac: null
	};

	current_batch?.register_created_effect(effect);

	/** @type {Effect | null} */
	var e = effect;

	if ((type & EFFECT) !== 0) {
		if (collected_effects !== null) {
			// created during traversal — collect and run afterwards
			collected_effects.push(effect);
		} else {
			// schedule for later
			Batch.ensure().schedule(effect);
		}
	} else if (fn !== null) {
		try {
			update_effect(effect);
		} catch (e) {
			destroy_effect(effect);
			throw e;
		}

		// if an effect doesn't need to be kept in the tree (because it
		// won't re-run, has no DOM, and has no teardown etc)
		// then we skip it and go to its child (if any)
		if (
			e.deps === null &&
			e.teardown === null &&
			e.nodes === null &&
			e.first === e.last && // either `null`, or a singular child
			(e.f & EFFECT_PRESERVED) === 0
		) {
			e = e.first;
			if ((type & BLOCK_EFFECT) !== 0 && (type & EFFECT_TRANSPARENT) !== 0 && e !== null) {
				e.f |= EFFECT_TRANSPARENT;
			}
		}
	}

	if (e !== null) {
		e.parent = parent;

		if (parent !== null) {
			push_effect(e, parent);
		}

		// if we're in a derived, add the effect there too
		if (
			active_reaction !== null &&
			(active_reaction.f & DERIVED) !== 0 &&
			(type & ROOT_EFFECT) === 0
		) {
			var derived = /** @type {Derived} */ (active_reaction);
			(derived.effects ??= []).push(e);
		}
	}

	return effect;
}

/**
 * Internal representation of `$effect.tracking()`
 * @returns {boolean}
 */
function effect_tracking() {
	return active_reaction !== null && !untracking;
}

/**
 * @param {() => void} fn
 */
function teardown(fn) {
	const effect = create_effect(RENDER_EFFECT, null);
	set_signal_status(effect, CLEAN);
	effect.teardown = fn;
	return effect;
}

/**
 * Internal representation of `$effect(...)`
 * @param {() => void | (() => void)} fn
 */
function user_effect(fn) {
	validate_effect();

	// Non-nested `$effect(...)` in a component should be deferred
	// until the component is mounted
	var flags = /** @type {Effect} */ (active_effect).f;
	var defer =
		!active_reaction &&
		(flags & BRANCH_EFFECT) !== 0 &&
		component_context !== null &&
		!component_context.i;

	if (defer) {
		// Top-level `$effect(...)` in an unmounted component — defer until mount
		var context = /** @type {ComponentContext} */ (component_context);
		(context.e ??= []).push(fn);
	} else {
		// Everything else — create immediately
		return create_user_effect(fn);
	}
}

/**
 * @param {() => void | (() => void)} fn
 */
function create_user_effect(fn) {
	return create_effect(EFFECT | USER_EFFECT, fn);
}

/**
 * Internal representation of `$effect.pre(...)`
 * @param {() => void | (() => void)} fn
 * @returns {Effect}
 */
function user_pre_effect(fn) {
	validate_effect();
	return create_effect(RENDER_EFFECT | USER_EFFECT, fn);
}

/**
 * An effect root whose children can transition out
 * @param {() => void} fn
 * @returns {(options?: { outro?: boolean }) => Promise<void>}
 */
function component_root(fn) {
	Batch.ensure();
	const effect = create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);

	return (options = {}) => {
		return new Promise((fulfil) => {
			if (options.outro) {
				pause_effect(effect, () => {
					destroy_effect(effect);
					fulfil(undefined);
				});
			} else {
				destroy_effect(effect);
				fulfil(undefined);
			}
		});
	};
}

/**
 * @param {() => void | (() => void)} fn
 * @returns {Effect}
 */
function effect(fn) {
	return create_effect(EFFECT, fn);
}

/**
 * @param {() => void | (() => void)} fn
 * @returns {Effect}
 */
function async_effect(fn) {
	return create_effect(ASYNC | EFFECT_PRESERVED, fn);
}

/**
 * @param {() => void | (() => void)} fn
 * @returns {Effect}
 */
function render_effect(fn, flags = 0) {
	return create_effect(RENDER_EFFECT | flags, fn);
}

/**
 * @param {(...expressions: any) => void | (() => void)} fn
 * @param {Array<() => any>} sync
 * @param {Array<() => Promise<any>>} async
 * @param {Blocker[]} blockers
 */
function template_effect(fn, sync = [], async = [], blockers = []) {
	flatten(blockers, sync, async, (values) => {
		create_effect(RENDER_EFFECT, () => {
			fn(...values.map(get));
		});
	});
}

/**
 * @param {(() => void)} fn
 * @param {number} flags
 */
function block(fn, flags = 0) {
	var effect = create_effect(BLOCK_EFFECT | flags, fn);
	return effect;
}

/**
 * @param {(() => void)} fn
 * @param {number} flags
 */
function managed(fn, flags = 0) {
	var effect = create_effect(MANAGED_EFFECT | flags, fn);
	return effect;
}

/**
 * @param {(() => void)} fn
 */
function branch(fn) {
	return create_effect(BRANCH_EFFECT | EFFECT_PRESERVED, fn);
}

/**
 * @param {Effect} effect
 */
function execute_effect_teardown(effect) {
	var teardown = effect.teardown;
	if (teardown !== null) {
		const previously_destroying_effect = is_destroying_effect;
		const previous_reaction = active_reaction;
		set_is_destroying_effect(true);
		set_active_reaction(null);
		try {
			teardown.call(null);
		} finally {
			set_is_destroying_effect(previously_destroying_effect);
			set_active_reaction(previous_reaction);
		}
	}
}

/**
 * @param {Effect} signal
 * @param {boolean} remove_dom
 * @returns {void}
 */
function destroy_effect_children(signal, remove_dom = false) {
	var effect = signal.first;
	signal.first = signal.last = null;

	while (effect !== null) {
		const controller = effect.ac;

		if (controller !== null) {
			without_reactive_context(() => {
				controller.abort(STALE_REACTION);
			});
		}

		var next = effect.next;

		if ((effect.f & ROOT_EFFECT) !== 0) {
			// this is now an independent root
			effect.parent = null;
		} else {
			destroy_effect(effect, remove_dom);
		}

		effect = next;
	}
}

/**
 * @param {Effect} signal
 * @returns {void}
 */
function destroy_block_effect_children(signal) {
	var effect = signal.first;

	while (effect !== null) {
		var next = effect.next;
		if ((effect.f & BRANCH_EFFECT) === 0) {
			destroy_effect(effect);
		}
		effect = next;
	}
}

/**
 * @param {Effect} effect
 * @param {boolean} [remove_dom]
 * @returns {void}
 */
function destroy_effect(effect, remove_dom = true) {
	var removed = false;

	if (
		(remove_dom || (effect.f & HEAD_EFFECT) !== 0) &&
		effect.nodes !== null &&
		effect.nodes.end !== null
	) {
		remove_effect_dom(effect.nodes.start, /** @type {TemplateNode} */ (effect.nodes.end));
		removed = true;
	}

	effect.f |= DESTROYING;
	destroy_effect_children(effect, remove_dom && !removed);
	remove_reactions(effect, 0);

	var transitions = effect.nodes && effect.nodes.t;

	if (transitions !== null) {
		for (const transition of transitions) {
			transition.stop();
		}
	}

	execute_effect_teardown(effect);

	effect.f ^= DESTROYING;
	effect.f |= DESTROYED;

	var parent = effect.parent;

	// If the parent doesn't have any children, then skip this work altogether
	if (parent !== null && parent.first !== null) {
		unlink_effect(effect);
	}

	// `first` and `child` are nulled out in destroy_effect_children
	// we don't null out `parent` so that error propagation can work correctly
	effect.next =
		effect.prev =
		effect.teardown =
		effect.ctx =
		effect.deps =
		effect.fn =
		effect.nodes =
		effect.ac =
		effect.b =
			null;
}

/**
 *
 * @param {TemplateNode | null} node
 * @param {TemplateNode} end
 */
function remove_effect_dom(node, end) {
	while (node !== null) {
		/** @type {TemplateNode | null} */
		var next = node === end ? null : get_next_sibling(node);

		node.remove();
		node = next;
	}
}

/**
 * Detach an effect from the effect tree, freeing up memory and
 * reducing the amount of work that happens on subsequent traversals
 * @param {Effect} effect
 */
function unlink_effect(effect) {
	var parent = effect.parent;
	var prev = effect.prev;
	var next = effect.next;

	if (prev !== null) prev.next = next;
	if (next !== null) next.prev = prev;

	if (parent !== null) {
		if (parent.first === effect) parent.first = next;
		if (parent.last === effect) parent.last = prev;
	}
}

/**
 * When a block effect is removed, we don't immediately destroy it or yank it
 * out of the DOM, because it might have transitions. Instead, we 'pause' it.
 * It stays around (in memory, and in the DOM) until outro transitions have
 * completed, and if the state change is reversed then we _resume_ it.
 * A paused effect does not update, and the DOM subtree becomes inert.
 * @param {Effect} effect
 * @param {() => void} [callback]
 * @param {boolean} [destroy]
 */
function pause_effect(effect, callback, destroy = true) {
	/** @type {TransitionManager[]} */
	var transitions = [];

	pause_children(effect, transitions, true);

	var fn = () => {
		if (destroy) destroy_effect(effect);
		if (callback) callback();
	};

	var remaining = transitions.length;
	if (remaining > 0) {
		var check = () => --remaining || fn();
		for (var transition of transitions) {
			transition.out(check);
		}
	} else {
		fn();
	}
}

/**
 * @param {Effect} effect
 * @param {TransitionManager[]} transitions
 * @param {boolean} local
 */
function pause_children(effect, transitions, local) {
	if ((effect.f & INERT) !== 0) return;
	effect.f ^= INERT;

	var t = effect.nodes && effect.nodes.t;

	if (t !== null) {
		for (const transition of t) {
			if (transition.is_global || local) {
				transitions.push(transition);
			}
		}
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;

		// If this child is a root effect, then it will become an independent root when its parent
		// is destroyed, it should therefore not become inert nor partake in transitions.
		if ((child.f & ROOT_EFFECT) === 0) {
			var transparent =
				(child.f & EFFECT_TRANSPARENT) !== 0 ||
				// If this is a branch effect without a block effect parent,
				// it means the parent block effect was pruned. In that case,
				// transparency information was transferred to the branch effect.
				((child.f & BRANCH_EFFECT) !== 0 && (effect.f & BLOCK_EFFECT) !== 0);
			// TODO we don't need to call pause_children recursively with a linked list in place
			// it's slightly more involved though as we have to account for `transparent` changing
			// through the tree.
			pause_children(child, transitions, transparent ? local : false);
		}

		child = sibling;
	}
}

/**
 * The opposite of `pause_effect`. We call this if (for example)
 * `x` becomes falsy then truthy: `{#if x}...{/if}`
 * @param {Effect} effect
 */
function resume_effect(effect) {
	resume_children(effect, true);
}

/**
 * @param {Effect} effect
 * @param {boolean} local
 */
function resume_children(effect, local) {
	if ((effect.f & INERT) === 0) return;
	effect.f ^= INERT;

	// If a dependency of this effect changed while it was paused,
	// schedule the effect to update. we don't use `is_dirty`
	// here because we don't want to eagerly recompute a derived like
	// `{#if foo}{foo.bar()}{/if}` if `foo` is now `undefined
	if ((effect.f & CLEAN) === 0) {
		set_signal_status(effect, DIRTY);
		Batch.ensure().schedule(effect); // Assumption: This happens during the commit phase of the batch, causing another flush, but it's safe
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;
		var transparent = (child.f & EFFECT_TRANSPARENT) !== 0 || (child.f & BRANCH_EFFECT) !== 0;
		// TODO we don't need to call resume_children recursively with a linked list in place
		// it's slightly more involved though as we have to account for `transparent` changing
		// through the tree.
		resume_children(child, transparent ? local : false);
		child = sibling;
	}

	var t = effect.nodes && effect.nodes.t;

	if (t !== null) {
		for (const transition of t) {
			if (transition.is_global || local) {
				transition.in();
			}
		}
	}
}

/**
 * @param {Effect} effect
 * @param {DocumentFragment} fragment
 */
function move_effect(effect, fragment) {
	if (!effect.nodes) return;

	/** @type {TemplateNode | null} */
	var node = effect.nodes.start;
	var end = effect.nodes.end;

	while (node !== null) {
		/** @type {TemplateNode | null} */
		var next = node === end ? null : get_next_sibling(node);

		fragment.append(node);
		node = next;
	}
}

const langToMomentLocale = {
    en: "en-gb",
    zh: "zh-cn",
    "zh-TW": "zh-tw",
    ru: "ru",
    ko: "ko",
    it: "it",
    id: "id",
    ro: "ro",
    "pt-BR": "pt-br",
    cz: "cs",
    da: "da",
    de: "de",
    es: "es",
    fr: "fr",
    no: "nn",
    pl: "pl",
    pt: "pt",
    tr: "tr",
    hi: "hi",
    nl: "nl",
    ar: "ar",
    ja: "ja",
};
const weekdays$1 = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
function overrideGlobalMomentWeekStart(weekStart) {
    const currentLocale = moment.locale();
    // Save the initial locale weekspec so that we can restore
    // it when toggling between the different options in settings.
    if (!window._bundledLocaleWeekSpec) {
        window._bundledLocaleWeekSpec = moment.localeData()._week;
    }
    if (weekStart === "locale") {
        moment.updateLocale(currentLocale, {
            week: window._bundledLocaleWeekSpec,
        });
    }
    else {
        moment.updateLocale(currentLocale, {
            week: {
                dow: weekdays$1.indexOf(weekStart) || 0,
            },
        });
    }
}
/**
 * Sets the locale used by the calendar. This allows the calendar to
 * default to the user's locale (e.g. Start Week on Sunday/Monday/Friday)
 *
 * @param localeOverride locale string (e.g. "en-US")
 */
function configureGlobalMomentLocale(localeOverride = "system-default", weekStart = "locale") {
    var _a;
    const obsidianLang = obsidian.getLanguage();
    const systemLang = (_a = navigator.language) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    let momentLocale = langToMomentLocale[obsidianLang];
    if (localeOverride !== "system-default") {
        momentLocale = localeOverride;
    }
    else if (systemLang.startsWith(obsidianLang)) {
        // If the system locale is more specific (en-gb vs en), use the system locale.
        momentLocale = systemLang;
    }
    const currentLocale = moment.locale(momentLocale);
    console.debug(`[Calendar] Trying to switch Moment.js global locale to ${momentLocale}, got ${currentLocale}`);
    overrideGlobalMomentWeekStart(weekStart);
    return currentLocale;
}

// Folder / template-file autocomplete for the settings tab, built on
// Obsidian's native AbstractInputSuggest (positioning, keyboard nav, popup
// lifecycle, and keymap scope are all handled by Obsidian). Each subclass
// keeps the same `(app, inputEl)` constructor and a `selectSuggestion` that
// writes the chosen path back and fires an `input` event, so the existing
// `Setting.addText(...).onChange(...)` handlers in settings.ts save on select
// without any call-site changes.
// Cap the rendered suggestion list to keep dropdown DOM cost bounded in large
// vaults. Typing a character or two narrows results well below this.
const MAX_SUGGESTIONS = 200;
class FileSuggest extends obsidian.AbstractInputSuggest {
    constructor(app, inputEl) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }
    getSuggestions(inputStr) {
        const lower = inputStr.toLowerCase();
        return this.app.vault
            .getAllLoadedFiles()
            .filter((f) => f instanceof obsidian.TFile &&
            f.extension === "md" &&
            f.path.toLowerCase().includes(lower))
            .sort((a, b) => a.path.localeCompare(b.path))
            .slice(0, MAX_SUGGESTIONS);
    }
    renderSuggestion(file, el) {
        el.setText(file.path);
    }
    selectSuggestion(file) {
        this.setValue(file.path);
        this.inputEl.trigger("input");
        this.close();
    }
}
class FolderSuggest extends obsidian.AbstractInputSuggest {
    constructor(app, inputEl) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }
    getSuggestions(inputStr) {
        const lower = inputStr.toLowerCase();
        return this.app.vault
            .getAllLoadedFiles()
            .filter((f) => f instanceof obsidian.TFolder && f.path.toLowerCase().includes(lower))
            .sort((a, b) => a.path.localeCompare(b.path))
            .slice(0, MAX_SUGGESTIONS);
    }
    renderSuggestion(folder, el) {
        el.setText(folder.path);
    }
    selectSuggestion(folder) {
        this.setValue(folder.path);
        this.inputEl.trigger("input");
        this.close();
    }
}

const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
const defaultSettings = Object.freeze({
    shouldConfirmBeforeCreate: true,
    weekStart: "locale",
    ctrlClickOpensInNewTab: false,
    showWeeklyNoteRight: false,
    shadeWeekendColumns: false,
    weekendDays: [0, 6],
    dotMode: "exists",
    wordsPerDot: 250,
    showTodayButtonOnMobile: false,
    showYearOverview: false,
    localeOverride: "system-default",
    daily: {
        enabled: true,
        format: DEFAULT_DAILY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    weekly: {
        enabled: false,
        format: DEFAULT_WEEKLY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    monthly: {
        enabled: false,
        format: DEFAULT_MONTHLY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    quarterly: {
        enabled: false,
        format: DEFAULT_QUARTERLY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    yearly: {
        enabled: false,
        format: DEFAULT_YEARLY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    secondDaily: {
        enabled: false,
        format: DEFAULT_DAILY_NOTE_FORMAT,
        folder: "",
        template: "",
    },
    featureImage: {
        enabled: false,
        frontmatterProperties: ["banner", "image", "cover"],
        showForWeekly: true,
        hiddenNotes: [],
    },
});
class CalendarSettingsTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        this.containerEl.empty();
        // Ensure window._bundledLocaleWeekSpec is initialized before
        // addWeekStartSetting reads it. Normally Calendar.svelte's getToday()
        // does this, but the user can open settings before the view mounts.
        configureGlobalMomentLocale(this.plugin.options.localeOverride, this.plugin.options.weekStart);
        new obsidian.Setting(this.containerEl).setName("Calendar behavior").setHeading();
        this.addConfirmCreateSetting();
        this.addCtrlClickSetting();
        this.displayDotStyleSection();
        this.addShowTodayButtonOnMobileSetting();
        this.addShowYearOverviewSetting();
        this.displayWeekendSection();
        this.displayFeatureImageSection();
        new obsidian.Setting(this.containerEl).setName("Periodic notes").setHeading();
        this.containerEl.createEl("p", {
            cls: "setting-item-description",
            text: "Calendar manages periodic notes directly. To use existing notes, enter the same folder and date format you already use.",
        });
        this.displayPeriodicNoteSettings("daily", "Daily notes", DEFAULT_DAILY_NOTE_FORMAT);
        this.displaySecondDailyNoteSettings();
        this.displayPeriodicNoteSettings("weekly", "Weekly notes", DEFAULT_WEEKLY_NOTE_FORMAT);
        this.displayPeriodicNoteSettings("monthly", "Monthly notes", DEFAULT_MONTHLY_NOTE_FORMAT);
        this.displayPeriodicNoteSettings("quarterly", "Quarterly notes", DEFAULT_QUARTERLY_NOTE_FORMAT);
        this.displayPeriodicNoteSettings("yearly", "Yearly notes", DEFAULT_YEARLY_NOTE_FORMAT);
        new obsidian.Setting(this.containerEl).setName("Locale").setHeading();
        this.addLocaleOverrideSetting();
    }
    addCtrlClickSetting() {
        new obsidian.Setting(this.containerEl)
            .setName("Ctrl/Cmd + Click Behavior")
            .setDesc("Set the behavior of Ctrl/Cmd-clicking calendar items.")
            .addDropdown((dropdown) => {
            dropdown.addOption("new-tab", "Open in new tab");
            dropdown.addOption("new-split", "Open in new split");
            dropdown.setValue(this.plugin.options.ctrlClickOpensInNewTab ? "new-tab" : "new-split");
            dropdown.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    ctrlClickOpensInNewTab: value === "new-tab",
                }));
            });
        });
    }
    addConfirmCreateSetting() {
        new obsidian.Setting(this.containerEl)
            .setName("Confirm before creating new note")
            .setDesc("Show a confirmation modal before creating a new note")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.shouldConfirmBeforeCreate);
            toggle.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    shouldConfirmBeforeCreate: value,
                }));
            });
        });
    }
    addShowTodayButtonOnMobileSetting() {
        new obsidian.Setting(this.containerEl)
            .setName("Show Today button on mobile")
            .setDesc("Show the Today button in the mobile calendar header.")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.showTodayButtonOnMobile);
            toggle.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    showTodayButtonOnMobile: value,
                }));
            });
        });
    }
    addShowYearOverviewSetting() {
        new obsidian.Setting(this.containerEl)
            .setName("Show history navigator button")
            .setDesc("Add a button to the calendar header that opens a 12-month grid for quickly jumping between months and years.")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.showYearOverview);
            toggle.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    showYearOverview: value,
                }));
            });
        });
    }
    displayWeekendSection() {
        const sectionEl = this.containerEl.createDiv();
        this.renderWeekendSection(sectionEl);
    }
    renderWeekendSection(sectionEl) {
        sectionEl.empty();
        new obsidian.Setting(sectionEl).setName("Weekend").setHeading();
        // Week start
        const localizedWeekdays = moment.weekdays();
        const localeWeekStartNum = window._bundledLocaleWeekSpec.dow;
        const localeWeekStart = moment.weekdays()[localeWeekStartNum];
        new obsidian.Setting(sectionEl)
            .setName("Start week on")
            .setDesc("Choose what day of the week to start. Select 'Locale default' to use the default specified by moment.js")
            .addDropdown((dropdown) => {
            dropdown.addOption("locale", `Locale default (${localeWeekStart})`);
            localizedWeekdays.forEach((day, i) => {
                dropdown.addOption(weekdays[i], day);
            });
            dropdown.setValue(this.plugin.options.weekStart);
            dropdown.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    weekStart: value,
                }));
            });
        });
        // Shade weekend columns
        new obsidian.Setting(sectionEl)
            .setName("Shade weekend columns")
            .setDesc("Tint weekend day columns so they stand out from weekdays. Off by default. When enabled you can customize which days count as the weekend.")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.shadeWeekendColumns);
            toggle.onChange(async (value) => {
                await this.plugin.writeOptions(() => ({ shadeWeekendColumns: value }));
                this.renderWeekendSection(sectionEl);
            });
        });
        if (!this.plugin.options.shadeWeekendColumns)
            return;
        // Locale-aware day names indexed by JS weekday: 0 = Sunday … 6 = Saturday.
        // Matches the index space used by `weekendDays` in settings and the
        // `date.day()` lookup in `isWeekend` (src/ui/calendar-ui/utils.ts).
        new obsidian.Setting(sectionEl)
            .setName("Weekend days")
            .setDesc('Choose which days are shaded when "Shade weekend columns" is enabled. Independent of the "Start week on" setting.');
        for (let i = 0; i < 7; i++) {
            const dayNum = i;
            new obsidian.Setting(sectionEl)
                .setName(localizedWeekdays[dayNum])
                .addToggle((toggle) => {
                toggle.setValue(this.plugin.options.weekendDays.includes(dayNum));
                toggle.onChange(async (selected) => {
                    const current = this.plugin.options.weekendDays;
                    const next = selected
                        ? [...current, dayNum].sort((a, b) => a - b)
                        : current.filter((d) => d !== dayNum);
                    void this.plugin.writeOptions(() => ({ weekendDays: next }));
                });
            });
        }
    }
    displayDotStyleSection() {
        const sectionEl = this.containerEl.createDiv();
        this.renderDotStyleSection(sectionEl);
    }
    renderDotStyleSection(sectionEl) {
        sectionEl.empty();
        new obsidian.Setting(sectionEl)
            .setName("Dot style")
            .setDesc("Choose what the dots on day and week cells represent.")
            .addDropdown((dropdown) => {
            dropdown.addOption("exists", "Note exists");
            dropdown.addOption("word-count-tasks", "Word count and open tasks");
            dropdown.setValue(this.plugin.options.dotMode);
            dropdown.onChange(async (value) => {
                await this.plugin.writeOptions(() => ({
                    dotMode: value,
                }));
                // Re-render only this section's wrapper so the "Words per dot"
                // sub-setting appears/disappears in place. Saved `wordsPerDot` is
                // untouched, so toggling back into "word-count-tasks" restores the
                // user's previous threshold.
                this.renderDotStyleSection(sectionEl);
            });
        });
        if (this.plugin.options.dotMode !== "word-count-tasks")
            return;
        new obsidian.Setting(sectionEl)
            .setName("Words per dot")
            .setDesc("Number of words per filled dot. Up to 5 dots per cell.")
            .addText((text) => {
            text.inputEl.type = "number";
            text.setPlaceholder("250");
            text.setValue(String(this.plugin.options.wordsPerDot));
            text.onChange(async (value) => {
                const parsed = value === "" ? 250 : Number(value);
                if (!Number.isFinite(parsed))
                    return;
                void this.plugin.writeOptions(() => ({ wordsPerDot: parsed }));
            });
        });
    }
    displayFeatureImageSection() {
        const sectionEl = this.containerEl.createDiv();
        this.renderFeatureImageSection(sectionEl);
    }
    renderFeatureImageSection(sectionEl) {
        sectionEl.empty();
        new obsidian.Setting(sectionEl).setName("Featured images").setHeading();
        new obsidian.Setting(sectionEl)
            .setName("Enable")
            .setDesc("Show the featured image from a daily or weekly note as the cell background.")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.featureImage.enabled);
            toggle.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    featureImage: Object.assign(Object.assign({}, prev.featureImage), { enabled: value }),
                }));
                this.renderFeatureImageSection(sectionEl);
            });
        });
        if (!this.plugin.options.featureImage.enabled)
            return;
        new obsidian.Setting(sectionEl)
            .setName("Frontmatter properties")
            .setDesc("Comma-separated frontmatter property names to check for an image path, in priority order. First matching vault image wins.")
            .addText((text) => {
            text.setPlaceholder("banner, image, cover");
            text.setValue(this.plugin.options.featureImage.frontmatterProperties.join(", "));
            text.onChange(async (value) => {
                const props = value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                await this.plugin.writeOptions((prev) => ({
                    featureImage: Object.assign(Object.assign({}, prev.featureImage), { frontmatterProperties: props }),
                }));
            });
        });
        new obsidian.Setting(sectionEl)
            .setName("Show for weekly notes")
            .setDesc("Show featured images on weekly note cells in addition to daily note cells.")
            .addToggle((toggle) => {
            toggle.setValue(this.plugin.options.featureImage.showForWeekly);
            toggle.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    featureImage: Object.assign(Object.assign({}, prev.featureImage), { showForWeekly: value }),
                }));
            });
        });
    }
    displayPeriodicNoteSettings(periodicity, label, defaultFormat) {
        const sectionEl = this.containerEl.createDiv();
        this.renderPeriodicNoteSection(sectionEl, periodicity, label, defaultFormat);
    }
    renderPeriodicNoteSection(sectionEl, periodicity, label, defaultFormat) {
        sectionEl.empty();
        const pnSettings = this.plugin.options[periodicity];
        new obsidian.Setting(sectionEl).setName(label).setHeading();
        new obsidian.Setting(sectionEl)
            .setName("Enable")
            .setDesc(`Create and manage ${label.toLowerCase()} from Calendar`)
            .addToggle((toggle) => {
            toggle.setValue(pnSettings.enabled);
            toggle.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    [periodicity]: Object.assign(Object.assign({}, prev[periodicity]), { enabled: value }),
                }));
                // Re-render only this section's wrapper. Calling this.display()
                // would empty the entire tab and reset the scroll container.
                this.renderPeriodicNoteSection(sectionEl, periodicity, label, defaultFormat);
            });
        });
        if (!pnSettings.enabled)
            return;
        // Weekly-only display setting: which side the week-number column lives on.
        // Placed right after Enable so the display preference is easy to find
        // when configuring Weekly notes. Only relevant when Weekly notes are
        // enabled (the column is hidden otherwise), so it lives here and
        // disappears with the rest of the weekly section when the user toggles
        // Weekly off. The persisted `showWeeklyNoteRight` key/default is
        // unchanged from when it lived under "Calendar behavior".
        if (periodicity === "weekly") {
            new obsidian.Setting(sectionEl)
                .setName("Change week number side")
                .setDesc("Show week numbers to the right of the calendar instead of the left.")
                .addToggle((toggle) => {
                toggle.setValue(this.plugin.options.showWeeklyNoteRight);
                toggle.onChange(async (value) => {
                    void this.plugin.writeOptions(() => ({ showWeeklyNoteRight: value }));
                });
            });
        }
        new obsidian.Setting(sectionEl)
            .setName("Date format")
            .setDesc("Moment.js format string for note filenames")
            .addText((text) => {
            text.setPlaceholder(defaultFormat);
            text.setValue(pnSettings.format);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    [periodicity]: Object.assign(Object.assign({}, prev[periodicity]), { format: value }),
                }));
            });
        });
        new obsidian.Setting(sectionEl)
            .setName("Folder")
            .setDesc("Notes are created here. Leave blank for vault root.")
            .addText((text) => {
            text.setPlaceholder("Example: folder/subfolder");
            text.setValue(pnSettings.folder);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    [periodicity]: Object.assign(Object.assign({}, prev[periodicity]), { folder: value }),
                }));
            });
            new FolderSuggest(this.app, text.inputEl);
        });
        new obsidian.Setting(sectionEl)
            .setName("Template file")
            .setDesc("Path to template file. Leave blank for no template.")
            .addText((text) => {
            text.setPlaceholder("Example: templates/daily");
            text.setValue(pnSettings.template);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    [periodicity]: Object.assign(Object.assign({}, prev[periodicity]), { template: value }),
                }));
            });
            new FileSuggest(this.app, text.inputEl);
        });
    }
    displaySecondDailyNoteSettings() {
        const sectionEl = this.containerEl.createDiv();
        this.renderSecondDailySection(sectionEl);
    }
    renderSecondDailySection(sectionEl) {
        sectionEl.empty();
        const pnSettings = this.plugin.options.secondDaily;
        new obsidian.Setting(sectionEl).setName("Second daily notes").setHeading();
        new obsidian.Setting(sectionEl)
            .setName("Enable")
            .setDesc("Allow the creation of a second daily note each day. Useful for meeting logs, keeping personal and work separate, etc. Access via right-click on any day cell.")
            .addToggle((toggle) => {
            toggle.setValue(pnSettings.enabled);
            toggle.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    secondDaily: Object.assign(Object.assign({}, prev.secondDaily), { enabled: value }),
                }));
                this.renderSecondDailySection(sectionEl);
            });
        });
        if (!pnSettings.enabled)
            return;
        new obsidian.Setting(sectionEl)
            .setName("Date format")
            .setDesc("Moment.js format string for note filenames")
            .addText((text) => {
            text.setPlaceholder(DEFAULT_DAILY_NOTE_FORMAT);
            text.setValue(pnSettings.format);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    secondDaily: Object.assign(Object.assign({}, prev.secondDaily), { format: value }),
                }));
            });
        });
        new obsidian.Setting(sectionEl)
            .setName("Folder")
            .setDesc("Notes are created here. Leave blank for vault root.")
            .addText((text) => {
            text.setPlaceholder("Example: folder/subfolder");
            text.setValue(pnSettings.folder);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    secondDaily: Object.assign(Object.assign({}, prev.secondDaily), { folder: value }),
                }));
            });
            new FolderSuggest(this.app, text.inputEl);
        });
        new obsidian.Setting(sectionEl)
            .setName("Template file")
            .setDesc("Path to template file. Leave blank for no template.")
            .addText((text) => {
            text.setPlaceholder("Example: templates/call-notes");
            text.setValue(pnSettings.template);
            text.onChange(async (value) => {
                await this.plugin.writeOptions((prev) => ({
                    secondDaily: Object.assign(Object.assign({}, prev.secondDaily), { template: value }),
                }));
            });
            new FileSuggest(this.app, text.inputEl);
        });
    }
    addLocaleOverrideSetting() {
        var _a;
        const sysLocale = (_a = navigator.language) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        new obsidian.Setting(this.containerEl)
            .setName("Override locale:")
            .setDesc("Set this if you want to use a locale different from the default")
            .addDropdown((dropdown) => {
            dropdown.addOption("system-default", `Same as system (${sysLocale})`);
            moment.locales().forEach((locale) => {
                dropdown.addOption(locale, locale);
            });
            dropdown.setValue(this.plugin.options.localeOverride);
            dropdown.onChange(async (value) => {
                void this.plugin.writeOptions(() => ({
                    localeOverride: value,
                }));
            });
        });
    }
}

const classList = (obj) => {
    return Object.entries(obj)
        .filter(([_k, v]) => !!v)
        .map(([k, _k]) => k);
};
function partition(arr, predicate) {
    const pass = [];
    const fail = [];
    arr.forEach((elem) => {
        if (predicate(elem)) {
            pass.push(elem);
        }
        else {
            fail.push(elem);
        }
    });
    return [pass, fail];
}
/**
 * Lookup the dateUID for a given file. It compares the filename
 * to the daily and weekly note formats to find a match.
 */
function getDateUIDFromFile(file, settings) {
    if (!file) {
        return null;
    }
    if (settings.daily.enabled) {
        const date = getDateFromFile(file, "daily", settings.daily.format);
        if (date) {
            return getDateUID(date, "daily");
        }
    }
    if (settings.weekly.enabled) {
        const date = getDateFromFile(file, "weekly", settings.weekly.format);
        if (date) {
            return getDateUID(date, "weekly");
        }
    }
    return null;
}

function createPeriodicNotesStore(periodicity) {
    let hasError = false;
    const store = writable(null);
    return Object.assign({ reindex: () => {
            const currentSettings = get$1(settings);
            if (!currentSettings[periodicity].enabled) {
                store.set({});
                hasError = false;
                return;
            }
            try {
                const notes = getAllPeriodicNotes(periodicity, currentSettings[periodicity]);
                store.set(notes);
                hasError = false;
            }
            catch (err) {
                store.set({});
                if (!hasError) {
                    // Avoid error being shown multiple times
                    console.log(`[Calendar] Failed to find ${periodicity} notes folder`, err);
                }
                hasError = true;
            }
        }, 
        // Incremental update for a single newly-created file. No-op when the
        // periodicity is disabled, when the file is outside the configured folder,
        // or when the basename doesn't parse against the configured format.
        // Returns true if the store was mutated.
        addFile: (file) => {
            const currentSettings = get$1(settings);
            const periodSettings = currentSettings[periodicity];
            if (!periodSettings.enabled)
                return false;
            if (!isFileInConfiguredFolder(file, periodSettings))
                return false;
            const date = getDateFromFile(file, periodicity, periodSettings.format);
            if (!date)
                return false;
            const uid = getDateUID(date, periodicity);
            store.update((current) => (Object.assign(Object.assign({}, (current !== null && current !== void 0 ? current : {})), { [uid]: file })));
            return true;
        }, 
        // Incremental remove for a single deleted file. Same guards as addFile.
        // Returns true if the UID was actually present in the store.
        removeFile: (file) => {
            const currentSettings = get$1(settings);
            const periodSettings = currentSettings[periodicity];
            if (!periodSettings.enabled)
                return false;
            if (!isFileInConfiguredFolder(file, periodSettings))
                return false;
            const date = getDateFromFile(file, periodicity, periodSettings.format);
            if (!date)
                return false;
            const uid = getDateUID(date, periodicity);
            let removed = false;
            store.update((current) => {
                // Only remove if this exact file owns the UID — two files under a
                // recursively-scanned folder can parse to the same date, and deleting
                // one shouldn't drop the other's entry.
                if (!current || current[uid] !== file)
                    return current;
                removed = true;
                const next = Object.assign({}, current);
                delete next[uid];
                return next;
            });
            return removed;
        }, 
        // Remove the entry that the old path mapped to, given the vault `rename`
        // event's `oldPath`. The file's current path/basename already reflect the
        // post-rename state, so we can't derive the old UID from a TFile — we
        // parse the old basename out of `oldPath` directly. Pairs with `addFile`
        // in the rename handler to move dots cleanly.
        removeByOldPath: (oldPath, file) => {
            const currentSettings = get$1(settings);
            const periodSettings = currentSettings[periodicity];
            if (!periodSettings.enabled)
                return false;
            if (!isPathInConfiguredFolder(oldPath, periodSettings))
                return false;
            const lastSlash = oldPath.lastIndexOf("/");
            const filename = lastSlash >= 0 ? oldPath.substring(lastSlash + 1) : oldPath;
            const oldBasename = filename.endsWith(".md")
                ? filename.substring(0, filename.length - 3)
                : filename;
            const date = getDateFromFilename(oldBasename, periodicity, periodSettings.format);
            if (!date)
                return false;
            const uid = getDateUID(date, periodicity);
            let removed = false;
            store.update((current) => {
                // Only remove if this exact file owns the UID. Compare by identity, NOT
                // by .path: Obsidian mutates TFile.path to the new path *before* firing
                // the rename event, so the stored entry's .path already equals the new
                // path — a .path===oldPath check would never match and would leak a
                // stale dot at the old date. (A different same-date file may hold it.)
                if (!current || current[uid] !== file)
                    return current;
                removed = true;
                const next = Object.assign({}, current);
                delete next[uid];
                return next;
            });
            return removed;
        } }, store);
}
// Exporting the stores
const settings = writable(defaultSettings);
const dailyNotes = createPeriodicNotesStore("daily");
const weeklyNotes = createPeriodicNotesStore("weekly");
const monthlyNotes = createPeriodicNotesStore("monthly");
const yearlyNotes = createPeriodicNotesStore("yearly");
const quarterlyNotes = createPeriodicNotesStore("quarterly");
// Second daily notes: same date granularity as daily, but independent folder/
// format/template. Uses "daily" periodicity for date parsing and UID generation;
// keyed separately from dailyNotes since it is a distinct store object.
function createSecondDailyNotesStore() {
    let hasError = false;
    const store = writable(null);
    return Object.assign({ reindex: () => {
            const { secondDaily } = get$1(settings);
            if (!secondDaily.enabled) {
                store.set({});
                hasError = false;
                return;
            }
            try {
                store.set(getAllPeriodicNotes("daily", secondDaily));
                hasError = false;
            }
            catch (err) {
                store.set({});
                if (!hasError) {
                    console.log("[Calendar] Failed to find second daily notes folder", err);
                }
                hasError = true;
            }
        }, addFile: (file) => {
            const { secondDaily } = get$1(settings);
            if (!secondDaily.enabled)
                return false;
            if (!isFileInConfiguredFolder(file, secondDaily))
                return false;
            const date = getDateFromFile(file, "daily", secondDaily.format);
            if (!date)
                return false;
            const uid = getDateUID(date, "daily");
            store.update((current) => (Object.assign(Object.assign({}, (current !== null && current !== void 0 ? current : {})), { [uid]: file })));
            return true;
        }, removeFile: (file) => {
            const { secondDaily } = get$1(settings);
            if (!secondDaily.enabled)
                return false;
            if (!isFileInConfiguredFolder(file, secondDaily))
                return false;
            const date = getDateFromFile(file, "daily", secondDaily.format);
            if (!date)
                return false;
            const uid = getDateUID(date, "daily");
            let removed = false;
            store.update((current) => {
                // Only remove if this exact file owns the UID (see periodic store).
                if (!current || current[uid] !== file)
                    return current;
                removed = true;
                const next = Object.assign({}, current);
                delete next[uid];
                return next;
            });
            return removed;
        }, removeByOldPath: (oldPath, file) => {
            const { secondDaily } = get$1(settings);
            if (!secondDaily.enabled)
                return false;
            if (!isPathInConfiguredFolder(oldPath, secondDaily))
                return false;
            const lastSlash = oldPath.lastIndexOf("/");
            const filename = lastSlash >= 0 ? oldPath.substring(lastSlash + 1) : oldPath;
            const oldBasename = filename.endsWith(".md")
                ? filename.substring(0, filename.length - 3)
                : filename;
            const date = getDateFromFilename(oldBasename, "daily", secondDaily.format);
            if (!date)
                return false;
            const uid = getDateUID(date, "daily");
            let removed = false;
            store.update((current) => {
                // Only remove if this exact file owns the UID (compare by identity —
                // TFile.path is already the new path by the time rename fires; see the
                // periodic store's removeByOldPath for the full rationale).
                if (!current || current[uid] !== file)
                    return current;
                removed = true;
                const next = Object.assign({}, current);
                delete next[uid];
                return next;
            });
            return removed;
        } }, store);
}
const secondDailyNotes = createSecondDailyNotesStore();
function createSelectedFileStore() {
    const store = writable(null);
    return Object.assign({ setFile: (file) => {
            const id = file ? getDateUIDFromFile(file, get$1(settings)) : null;
            store.set(id);
        } }, store);
}
const activeFile = createSelectedFileStore();
// Tracks whether the active file is a *second* daily note, so its day cell can
// show a distinct (grey) highlight. Detection is folder-aware (checks the
// configured second-daily folder + format) rather than relying on
// getDateUIDFromFile, so a second daily note is never mistaken for a primary
// daily note even when the two share a date format.
function createActiveSecondDailyStore() {
    const store = writable(null);
    return Object.assign({ setFile: (file) => {
            const { secondDaily } = get$1(settings);
            if (!file || !secondDaily.enabled || !isFileInConfiguredFolder(file, secondDaily)) {
                store.set(null);
                return;
            }
            const date = getDateFromFile(file, "daily", secondDaily.format);
            store.set(date ? getDateUID(date, "daily") : null);
        } }, store);
}
const activeSecondDailyFile = createActiveSecondDailyStore();

/**
 * @param {string} name
 */
function is_capture_event(name) {
	return name.endsWith('capture') && name !== 'gotpointercapture' && name !== 'lostpointercapture';
}

/** List of Element events that will be delegated */
const DELEGATED_EVENTS = [
	'beforeinput',
	'click',
	'change',
	'dblclick',
	'contextmenu',
	'focusin',
	'focusout',
	'input',
	'keydown',
	'keyup',
	'mousedown',
	'mousemove',
	'mouseout',
	'mouseover',
	'mouseup',
	'pointerdown',
	'pointermove',
	'pointerout',
	'pointerover',
	'pointerup',
	'touchend',
	'touchmove',
	'touchstart'
];

/**
 * Returns `true` if `event_name` is a delegated event
 * @param {string} event_name
 */
function can_delegate_event(event_name) {
	return DELEGATED_EVENTS.includes(event_name);
}

/**
 * @type {Record<string, string>}
 * List of attribute names that should be aliased to their property names
 * because they behave differently between setting them as an attribute and
 * setting them as a property.
 */
const ATTRIBUTE_ALIASES = {
	// no `class: 'className'` because we handle that separately
	formnovalidate: 'formNoValidate',
	ismap: 'isMap',
	nomodule: 'noModule',
	playsinline: 'playsInline',
	readonly: 'readOnly',
	defaultvalue: 'defaultValue',
	defaultchecked: 'defaultChecked',
	srcobject: 'srcObject',
	novalidate: 'noValidate',
	allowfullscreen: 'allowFullscreen',
	disablepictureinpicture: 'disablePictureInPicture',
	disableremoteplayback: 'disableRemotePlayback'
};

/**
 * @param {string} name
 */
function normalize_attribute(name) {
	name = name.toLowerCase();
	return ATTRIBUTE_ALIASES[name] ?? name;
}

/**
 * Subset of delegated events which should be passive by default.
 * These two are already passive via browser defaults on window, document and body.
 * But since
 * - we're delegating them
 * - they happen often
 * - they apply to mobile which is generally less performant
 * we're marking them as passive by default for other elements, too.
 */
const PASSIVE_EVENTS = ['touchstart', 'touchmove'];

/**
 * Returns `true` if `name` is a passive event
 * @param {string} name
 */
function is_passive_event(name) {
	return PASSIVE_EVENTS.includes(name);
}

/**
 * Used on elements, as a map of event type -> event handler,
 * and on events themselves to track which element handled an event
 */
const event_symbol = Symbol('events');

/** @type {Set<string>} */
const all_registered_events = new Set();

/** @type {Set<(events: Array<string>) => void>} */
const root_event_handles = new Set();

/**
 * @param {string} event_name
 * @param {EventTarget} dom
 * @param {EventListener} [handler]
 * @param {AddEventListenerOptions} [options]
 */
function create_event(event_name, dom, handler, options = {}) {
	/**
	 * @this {EventTarget}
	 */
	function target_handler(/** @type {Event} */ event) {
		if (!options.capture) {
			// Only call in the bubble phase, else delegated events would be called before the capturing events
			handle_event_propagation.call(dom, event);
		}
		if (!event.cancelBubble) {
			return without_reactive_context(() => {
				return handler?.call(this, event);
			});
		}
	}

	// Chrome has a bug where pointer events don't work when attached to a DOM element that has been cloned
	// with cloneNode() and the DOM element is disconnected from the document. To ensure the event works, we
	// defer the attachment till after it's been appended to the document. TODO: remove this once Chrome fixes
	// this bug. The same applies to wheel events and touch events.
	if (
		event_name.startsWith('pointer') ||
		event_name.startsWith('touch') ||
		event_name === 'wheel'
	) {
		queue_micro_task(() => {
			dom.addEventListener(event_name, target_handler, options);
		});
	} else {
		dom.addEventListener(event_name, target_handler, options);
	}

	return target_handler;
}

/**
 * @param {string} event_name
 * @param {Element} dom
 * @param {EventListener} [handler]
 * @param {boolean} [capture]
 * @param {boolean} [passive]
 * @returns {void}
 */
function event(event_name, dom, handler, capture, passive) {
	var options = { capture, passive };
	var target_handler = create_event(event_name, dom, handler, options);

	if (
		dom === document.body ||
		// @ts-ignore
		dom === window ||
		// @ts-ignore
		dom === document ||
		// Firefox has quirky behavior, it can happen that we still get "canplay" events when the element is already removed
		dom instanceof HTMLMediaElement
	) {
		teardown(() => {
			dom.removeEventListener(event_name, target_handler, options);
		});
	}
}

/**
 * @param {string} event_name
 * @param {Element} element
 * @param {EventListener} [handler]
 * @returns {void}
 */
function delegated(event_name, element, handler) {
	// @ts-expect-error
	(element[event_symbol] ??= {})[event_name] = handler;
}

/**
 * @param {Array<string>} events
 * @returns {void}
 */
function delegate(events) {
	for (var i = 0; i < events.length; i++) {
		all_registered_events.add(events[i]);
	}

	for (var fn of root_event_handles) {
		fn(events);
	}
}

// used to store the reference to the currently propagated event
// to prevent garbage collection between microtasks in Firefox
// If the event object is GCed too early, the expando __root property
// set on the event object is lost, causing the event delegation
// to process the event twice
let last_propagated_event = null;

/**
 * @this {EventTarget}
 * @param {Event} event
 * @returns {void}
 */
function handle_event_propagation(event) {
	var handler_element = this;
	var owner_document = /** @type {Node} */ (handler_element).ownerDocument;
	var event_name = event.type;
	var path = event.composedPath?.() || [];
	var current_target = /** @type {null | Element} */ (path[0] || event.target);

	last_propagated_event = event;

	// composedPath contains list of nodes the event has propagated through.
	// We check `event_symbol` to skip all nodes below it in case this is a
	// parent of the `event_symbol` node, which indicates that there's nested
	// mounted apps. In this case we don't want to trigger events multiple times.
	var path_idx = 0;

	// the `last_propagated_event === event` check is redundant, but
	// without it the variable will be DCE'd and things will
	// fail mysteriously in Firefox
	// @ts-expect-error is added below
	var handled_at = last_propagated_event === event && event[event_symbol];

	if (handled_at) {
		var at_idx = path.indexOf(handled_at);
		if (
			at_idx !== -1 &&
			(handler_element === document || handler_element === /** @type {any} */ (window))
		) {
			// This is the fallback document listener or a window listener, but the event was already handled
			// -> ignore, but set handle_at to document/window so that we're resetting the event
			// chain in case someone manually dispatches the same event object again.
			// @ts-expect-error
			event[event_symbol] = handler_element;
			return;
		}

		// We're deliberately not skipping if the index is higher, because
		// someone could create an event programmatically and emit it multiple times,
		// in which case we want to handle the whole propagation chain properly each time.
		// (this will only be a false negative if the event is dispatched multiple times and
		// the fallback document listener isn't reached in between, but that's super rare)
		var handler_idx = path.indexOf(handler_element);
		if (handler_idx === -1) {
			// handle_idx can theoretically be -1 (happened in some JSDOM testing scenarios with an event listener on the window object)
			// so guard against that, too, and assume that everything was handled at this point.
			return;
		}

		if (at_idx <= handler_idx) {
			path_idx = at_idx;
		}
	}

	current_target = /** @type {Element} */ (path[path_idx] || event.target);
	// there can only be one delegated event per element, and we either already handled the current target,
	// or this is the very first target in the chain which has a non-delegated listener, in which case it's safe
	// to handle a possible delegated event on it later (through the root delegation listener for example).
	if (current_target === handler_element) return;

	// Proxy currentTarget to correct target
	define_property(event, 'currentTarget', {
		configurable: true,
		get() {
			return current_target || owner_document;
		}
	});

	// This started because of Chromium issue https://chromestatus.com/feature/5128696823545856,
	// where removal or moving of the DOM can cause sync `blur` events to fire, which can cause logic
	// to run inside the current `active_reaction`, which isn't what we want at all. However, on reflection,
	// it's probably best that all events handled by Svelte have this behaviour, as we don't really want
	// an event handler to run in the context of another reaction or effect.
	var previous_reaction = active_reaction;
	var previous_effect = active_effect;
	set_active_reaction(null);
	set_active_effect(null);

	try {
		/**
		 * @type {unknown}
		 */
		var throw_error;
		/**
		 * @type {unknown[]}
		 */
		var other_errors = [];

		while (current_target !== null) {
			if (current_target === handler_element) break;

			try {
				// @ts-expect-error
				var delegated = current_target[event_symbol]?.[event_name];

				if (
					delegated != null &&
					(!(/** @type {any} */ (current_target).disabled) ||
						// DOM could've been updated already by the time this is reached, so we check this as well
						// -> the target could not have been disabled because it emits the event in the first place
						event.target === current_target)
				) {
					delegated.call(current_target, event);
				}
			} catch (error) {
				if (throw_error) {
					other_errors.push(error);
				} else {
					throw_error = error;
				}
			}
			if (event.cancelBubble) break;

			path_idx++;
			current_target = path_idx < path.length ? /** @type {Element} */ (path[path_idx]) : null;
		}

		if (throw_error) {
			for (let error of other_errors) {
				// Throw the rest of the errors, one-by-one on a microtask
				queueMicrotask(() => {
					throw error;
				});
			}
			throw throw_error;
		}
	} finally {
		// @ts-expect-error is used above
		event[event_symbol] = handler_element;
		// @ts-ignore remove proxy on currentTarget
		delete event.currentTarget;
		set_active_reaction(previous_reaction);
		set_active_effect(previous_effect);
	}
}

const policy =
	// We gotta write it like this because after downleveling the pure comment may end up in the wrong location
	globalThis?.window?.trustedTypes &&
	/* @__PURE__ */ globalThis.window.trustedTypes.createPolicy('svelte-trusted-html', {
		/** @param {string} html */
		createHTML: (html) => {
			return html;
		}
	});

/** @param {string} html */
function create_trusted_html(html) {
	return /** @type {string} */ (policy?.createHTML(html) ?? html);
}

/**
 * @param {string} html
 */
function create_fragment_from_html(html) {
	var elem = create_element('template');
	elem.innerHTML = create_trusted_html(html.replaceAll('<!>', '<!---->')); // XHTML compliance
	return elem.content;
}

/** @import { Effect, EffectNodes, TemplateNode } from '#client' */
/** @import { TemplateStructure } from './types' */

/**
 * @param {TemplateNode} start
 * @param {TemplateNode | null} end
 */
function assign_nodes(start, end) {
	var effect = /** @type {Effect} */ (active_effect);
	if (effect.nodes === null) {
		effect.nodes = { start, end, a: null, t: null };
	}
}

/**
 * @param {string} content
 * @param {number} flags
 * @returns {() => Node | Node[]}
 */
/*#__NO_SIDE_EFFECTS__*/
function from_html(content, flags) {
	var is_fragment = (flags & TEMPLATE_FRAGMENT) !== 0;
	var use_import_node = (flags & TEMPLATE_USE_IMPORT_NODE) !== 0;

	/** @type {Node} */
	var node;

	/**
	 * Whether or not the first item is a text/element node. If not, we need to
	 * create an additional comment node to act as `effect.nodes.start`
	 */
	var has_start = !content.startsWith('<!>');

	return () => {

		if (node === undefined) {
			node = create_fragment_from_html(has_start ? content : '<!>' + content);
			if (!is_fragment) node = /** @type {TemplateNode} */ (get_first_child(node));
		}

		var clone = /** @type {TemplateNode} */ (
			use_import_node || is_firefox ? document.importNode(node, true) : node.cloneNode(true)
		);

		if (is_fragment) {
			var start = /** @type {TemplateNode} */ (get_first_child(clone));
			var end = /** @type {TemplateNode} */ (clone.lastChild);

			assign_nodes(start, end);
		} else {
			assign_nodes(clone, clone);
		}

		return clone;
	};
}

/**
 * @param {string} content
 * @param {number} flags
 * @param {'svg' | 'math'} ns
 * @returns {() => Node | Node[]}
 */
/*#__NO_SIDE_EFFECTS__*/
function from_namespace(content, flags, ns = 'svg') {
	/**
	 * Whether or not the first item is a text/element node. If not, we need to
	 * create an additional comment node to act as `effect.nodes.start`
	 */
	var has_start = !content.startsWith('<!>');
	var wrapped = `<${ns}>${has_start ? content : '<!>' + content}</${ns}>`;

	/** @type {Element | DocumentFragment} */
	var node;

	return () => {

		if (!node) {
			var fragment = /** @type {DocumentFragment} */ (create_fragment_from_html(wrapped));
			var root = /** @type {Element} */ (get_first_child(fragment));

			{
				node = /** @type {Element} */ (get_first_child(root));
			}
		}

		var clone = /** @type {TemplateNode} */ (node.cloneNode(true));

		{
			assign_nodes(clone, clone);
		}

		return clone;
	};
}

/**
 * @param {string} content
 * @param {number} flags
 */
/*#__NO_SIDE_EFFECTS__*/
function from_svg(content, flags) {
	return from_namespace(content, flags, 'svg');
}

/**
 * @returns {TemplateNode | DocumentFragment}
 */
function comment() {

	var frag = document.createDocumentFragment();
	var start = document.createComment('');
	var anchor = create_text();
	frag.append(start, anchor);

	assign_nodes(start, anchor);

	return frag;
}

/**
 * Assign the created (or in hydration mode, traversed) dom elements to the current block
 * and insert the elements into the dom (in client mode).
 * @param {Text | Comment | Element} anchor
 * @param {DocumentFragment | Element} dom
 */
function append(anchor, dom) {

	if (anchor === null) {
		// edge case — void `<svelte:element>` with content
		return;
	}

	anchor.before(/** @type {Node} */ (dom));
}

/** @import { ComponentContext, Effect, EffectNodes, TemplateNode } from '#client' */
/** @import { Component, ComponentType, SvelteComponent, MountOptions } from '../../index.js' */

/**
 * @param {Element} text
 * @param {string} value
 * @returns {void}
 */
function set_text(text, value) {
	// For objects, we apply string coercion (which might make things like $state array references in the template reactive) before diffing
	var str = value == null ? '' : typeof value === 'object' ? `${value}` : value;
	// prettier-ignore
	if (str !== (/** @type {any} */ (text)[TEXT_CACHE] ??= text.nodeValue)) {
		/** @type {any} */ (text)[TEXT_CACHE] = str;
		text.nodeValue = `${str}`;
	}
}

/**
 * Mounts a component to the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component.
 * Transitions will play during the initial render unless the `intro` option is set to `false`.
 *
 * @template {Record<string, any>} Props
 * @template {Record<string, any>} Exports
 * @param {ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>} component
 * @param {MountOptions<Props>} options
 * @returns {Exports}
 */
function mount(component, options) {
	return _mount(component, options);
}

/** @type {Map<EventTarget, Map<string, number>>} */
const listeners = new Map();

/**
 * @template {Record<string, any>} Exports
 * @param {ComponentType<SvelteComponent<any>> | Component<any>} Component
 * @param {MountOptions} options
 * @returns {Exports}
 */
function _mount(
	Component,
	{ target, anchor, props = {}, events, context, intro = true, transformError }
) {
	init_operations();

	/** @type {Exports} */
	// @ts-expect-error will be defined because the render effect runs synchronously
	var component = undefined;

	var unmount = component_root(() => {
		var anchor_node = anchor ?? target.appendChild(create_text());

		boundary(
			/** @type {TemplateNode} */ (anchor_node),
			{
				pending: () => {}
			},
			(anchor_node) => {
				push({});
				var ctx = /** @type {ComponentContext} */ (component_context);
				if (context) ctx.c = context;

				if (events) {
					// We can't spread the object or else we'd lose the state proxy stuff, if it is one
					/** @type {any} */ (props).$$events = events;
				}
				// @ts-expect-error the public typings are not what the actual function looks like
				component = Component(anchor_node, props) || {};

				pop();
			},
			transformError
		);

		// Setup event delegation _after_ component is mounted - if an error would happen during mount, it would otherwise not be cleaned up
		/** @type {Set<string>} */
		var registered_events = new Set();

		/** @param {Array<string>} events */
		var event_handle = (events) => {
			for (var i = 0; i < events.length; i++) {
				var event_name = events[i];

				if (registered_events.has(event_name)) continue;
				registered_events.add(event_name);

				var passive = is_passive_event(event_name);

				// Add the event listener to both the container and the document.
				// The container listener ensures we catch events from within in case
				// the outer content stops propagation of the event.
				//
				// The document listener ensures we catch events that originate from elements that were
				// manually moved outside of the container (e.g. via manual portals).
				for (const node of [target, document]) {
					var counts = listeners.get(node);

					if (counts === undefined) {
						counts = new Map();
						listeners.set(node, counts);
					}

					var count = counts.get(event_name);

					if (count === undefined) {
						node.addEventListener(event_name, handle_event_propagation, { passive });
						counts.set(event_name, 1);
					} else {
						counts.set(event_name, count + 1);
					}
				}
			}
		};

		event_handle(array_from(all_registered_events));
		root_event_handles.add(event_handle);

		return () => {
			for (var event_name of registered_events) {
				for (const node of [target, document]) {
					var counts = /** @type {Map<string, number>} */ (listeners.get(node));
					var count = /** @type {number} */ (counts.get(event_name));

					if (--count == 0) {
						node.removeEventListener(event_name, handle_event_propagation);
						counts.delete(event_name);

						if (counts.size === 0) {
							listeners.delete(node);
						}
					} else {
						counts.set(event_name, count);
					}
				}
			}

			root_event_handles.delete(event_handle);

			if (anchor_node !== anchor) {
				anchor_node.parentNode?.removeChild(anchor_node);
			}
		};
	});

	mounted_components.set(component, unmount);
	return component;
}

/**
 * References of the components that were mounted or hydrated.
 * Uses a `WeakMap` to avoid memory leaks.
 */
let mounted_components = new WeakMap();

/**
 * Unmounts a component that was previously mounted using `mount` or `hydrate`.
 *
 * Since 5.13.0, if `options.outro` is `true`, [transitions](https://svelte.dev/docs/svelte/transition) will play before the component is removed from the DOM.
 *
 * Returns a `Promise` that resolves after transitions have completed if `options.outro` is true, or immediately otherwise (prior to 5.13.0, returns `void`).
 *
 * ```js
 * import { mount, unmount } from 'svelte';
 * import App from './App.svelte';
 *
 * const app = mount(App, { target: document.body });
 *
 * // later...
 * unmount(app, { outro: true });
 * ```
 * @param {Record<string, any>} component
 * @param {{ outro?: boolean }} [options]
 * @returns {Promise<void>}
 */
function unmount(component, options) {
	const fn = mounted_components.get(component);

	if (fn) {
		mounted_components.delete(component);
		return fn(options);
	}

	return Promise.resolve();
}

/** @import { Effect, TemplateNode } from '#client' */

/**
 * @typedef {{ effect: Effect, fragment: DocumentFragment }} Branch
 */

/**
 * @template Key
 */
class BranchManager {
	/** @type {TemplateNode} */
	anchor;

	/** @type {Map<Batch, Key>} */
	#batches = new Map();

	/**
	 * Map of keys to effects that are currently rendered in the DOM.
	 * These effects are visible and actively part of the document tree.
	 * Example:
	 * ```
	 * {#if condition}
	 * 	foo
	 * {:else}
	 * 	bar
	 * {/if}
	 * ```
	 * Can result in the entries `true->Effect` and `false->Effect`
	 * @type {Map<Key, Effect>}
	 */
	#onscreen = new Map();

	/**
	 * Similar to #onscreen with respect to the keys, but contains branches that are not yet
	 * in the DOM, because their insertion is deferred.
	 * @type {Map<Key, Branch>}
	 */
	#offscreen = new Map();

	/**
	 * Keys of effects that are currently outroing
	 * @type {Set<Key>}
	 */
	#outroing = new Set();

	/**
	 * Whether to pause (i.e. outro) on change, or destroy immediately.
	 * This is necessary for `<svelte:element>`
	 */
	#transition = true;

	/**
	 * @param {TemplateNode} anchor
	 * @param {boolean} transition
	 */
	constructor(anchor, transition = true) {
		this.anchor = anchor;
		this.#transition = transition;
	}

	/**
	 * @param {Batch} batch
	 */
	#commit = (batch) => {
		// if this batch was made obsolete, bail
		if (!this.#batches.has(batch)) return;

		var key = /** @type {Key} */ (this.#batches.get(batch));

		var onscreen = this.#onscreen.get(key);

		if (onscreen) {
			// effect is already in the DOM — abort any current outro
			resume_effect(onscreen);
			this.#outroing.delete(key);
		} else {
			// effect is currently offscreen. put it in the DOM
			var offscreen = this.#offscreen.get(key);

			if (offscreen) {
				// effect could have been outro'ed before through a prior batch — resume if necessary
				resume_effect(offscreen.effect);
				this.#onscreen.set(key, offscreen.effect);
				this.#offscreen.delete(key);

				// remove the anchor...
				/** @type {TemplateNode} */ (offscreen.fragment.lastChild).remove();

				// ...and append the fragment
				this.anchor.before(offscreen.fragment);
				onscreen = offscreen.effect;
			}
		}

		for (const [b, k] of this.#batches) {
			this.#batches.delete(b);

			if (b === batch) {
				// keep values for newer batches
				break;
			}

			const offscreen = this.#offscreen.get(k);

			if (offscreen) {
				// for older batches, destroy offscreen effects
				// as they will never be committed
				destroy_effect(offscreen.effect);
				this.#offscreen.delete(k);
			}
		}

		// outro/destroy all onscreen effects...
		for (const [k, effect] of this.#onscreen) {
			// ...except the one that was just committed
			//    or those that are already outroing (else the transition is aborted and the effect destroyed right away)
			if (k === key || this.#outroing.has(k)) continue;

			const on_destroy = () => {
				const keys = Array.from(this.#batches.values());

				if (keys.includes(k)) {
					// keep the effect offscreen, as another batch will need it
					var fragment = document.createDocumentFragment();
					move_effect(effect, fragment);

					fragment.append(create_text()); // TODO can we avoid this?

					this.#offscreen.set(k, { effect, fragment });
				} else {
					destroy_effect(effect);
				}

				this.#outroing.delete(k);
				this.#onscreen.delete(k);
			};

			if (this.#transition || !onscreen) {
				this.#outroing.add(k);
				pause_effect(effect, on_destroy, false);
			} else {
				on_destroy();
			}
		}
	};

	/**
	 * @param {Batch} batch
	 */
	#discard = (batch) => {
		this.#batches.delete(batch);

		const keys = Array.from(this.#batches.values());

		for (const [k, branch] of this.#offscreen) {
			if (!keys.includes(k)) {
				destroy_effect(branch.effect);
				this.#offscreen.delete(k);
			}
		}
	};

	/**
	 *
	 * @param {any} key
	 * @param {null | ((target: TemplateNode) => void)} fn
	 */
	ensure(key, fn) {
		var batch = /** @type {Batch} */ (current_batch);
		var defer = should_defer_append();

		if (fn && !this.#onscreen.has(key) && !this.#offscreen.has(key)) {
			if (defer) {
				var fragment = document.createDocumentFragment();
				var target = create_text();

				fragment.append(target);

				this.#offscreen.set(key, {
					effect: branch(() => fn(target)),
					fragment
				});
			} else {
				this.#onscreen.set(
					key,
					branch(() => fn(this.anchor))
				);
			}
		}

		this.#batches.set(batch, key);

		if (defer) {
			for (const [k, effect] of this.#onscreen) {
				if (k === key) {
					batch.unskip_effect(effect);
				} else {
					batch.skip_effect(effect);
				}
			}

			for (const [k, branch] of this.#offscreen) {
				if (k === key) {
					batch.unskip_effect(branch.effect);
				} else {
					batch.skip_effect(branch.effect);
				}
			}

			batch.oncommit(this.#commit);
			batch.ondiscard(this.#discard);
		} else {

			this.#commit(batch);
		}
	}
}

/** @import { TemplateNode } from '#client' */

/**
 * @param {TemplateNode} node
 * @param {(branch: (fn: (anchor: Node) => void, key?: number | false) => void) => void} fn
 * @param {boolean} [elseif] True if this is an `{:else if ...}` block rather than an `{#if ...}`, as that affects which transitions are considered 'local'
 * @returns {void}
 */
function if_block(node, fn, elseif = false) {

	var branches = new BranchManager(node);
	var flags = elseif ? EFFECT_TRANSPARENT : 0;

	/**
	 * @param {number | false} key
	 * @param {null | ((anchor: Node) => void)} fn
	 */
	function update_branch(key, fn) {

		branches.ensure(key, fn);
	}

	block(() => {
		var has_branch = false;

		fn((fn, key = 0) => {
			has_branch = true;
			update_branch(key, fn);
		});

		if (!has_branch) {
			update_branch(-1, null);
		}
	}, flags);
}

/** @import { EachItem, EachOutroGroup, EachState, Effect, EffectNodes, MaybeSource, Source, TemplateNode, TransitionManager, Value } from '#client' */
/** @import { Batch } from '../../reactivity/batch.js'; */

// When making substantive changes to this file, validate them with the each block stress test:
// https://svelte.dev/playground/1972b2cf46564476ad8c8c6405b23b7b
// This test also exists in this repo, as `packages/svelte/tests/manual/each-stress-test`

/**
 * @param {any} _
 * @param {number} i
 */
function index(_, i) {
	return i;
}

/**
 * Pause multiple effects simultaneously, and coordinate their
 * subsequent destruction. Used in each blocks
 * @param {EachState} state
 * @param {Effect[]} to_destroy
 * @param {null | Node} controlled_anchor
 */
function pause_effects(state, to_destroy, controlled_anchor) {
	/** @type {TransitionManager[]} */
	var transitions = [];
	var length = to_destroy.length;

	/** @type {EachOutroGroup} */
	var group;
	var remaining = to_destroy.length;

	for (var i = 0; i < length; i++) {
		let effect = to_destroy[i];

		pause_effect(
			effect,
			() => {
				if (group) {
					group.pending.delete(effect);
					group.done.add(effect);

					if (group.pending.size === 0) {
						var groups = /** @type {Set<EachOutroGroup>} */ (state.outrogroups);

						destroy_effects(state, array_from(group.done));
						groups.delete(group);

						if (groups.size === 0) {
							state.outrogroups = null;
						}
					}
				} else {
					remaining -= 1;
				}
			},
			false
		);
	}

	if (remaining === 0) {
		// If we're in a controlled each block (i.e. the block is the only child of an
		// element), and we are removing all items, _and_ there are no out transitions,
		// we can use the fast path — emptying the element and replacing the anchor
		var fast_path = transitions.length === 0 && controlled_anchor !== null;

		if (fast_path) {
			var anchor = /** @type {Element} */ (controlled_anchor);
			var parent_node = /** @type {Element} */ (anchor.parentNode);

			clear_text_content(parent_node);
			parent_node.append(anchor);

			state.items.clear();
		}

		destroy_effects(state, to_destroy, !fast_path);
	} else {
		group = {
			pending: new Set(to_destroy),
			done: new Set()
		};

		(state.outrogroups ??= new Set()).add(group);
	}
}

/**
 * @param {EachState} state
 * @param {Effect[]} to_destroy
 * @param {boolean} remove_dom
 */
function destroy_effects(state, to_destroy, remove_dom = true) {
	/** @type {Set<Effect> | undefined} */
	var preserved_effects;

	// The loop-in-a-loop isn't ideal, but we should only hit this in relatively rare cases
	if (state.pending.size > 0) {
		preserved_effects = new Set();

		for (const keys of state.pending.values()) {
			for (const key of keys) {
				preserved_effects.add(/** @type {EachItem} */ (state.items.get(key)).e);
			}
		}
	}

	for (var i = 0; i < to_destroy.length; i++) {
		var e = to_destroy[i];

		if (preserved_effects?.has(e)) {
			e.f |= EFFECT_OFFSCREEN;

			const fragment = document.createDocumentFragment();
			move_effect(e, fragment);
		} else {
			destroy_effect(to_destroy[i], remove_dom);
		}
	}
}

/** @type {TemplateNode} */
var offscreen_anchor;

/**
 * @template V
 * @param {Element | Comment} node The next sibling node, or the parent node if this is a 'controlled' block
 * @param {number} flags
 * @param {() => V[]} get_collection
 * @param {(value: V, index: number) => any} get_key
 * @param {(anchor: Node, item: MaybeSource<V>, index: MaybeSource<number>) => void} render_fn
 * @param {null | ((anchor: Node) => void)} fallback_fn
 * @returns {void}
 */
function each(node, flags, get_collection, get_key, render_fn, fallback_fn = null) {
	var anchor = node;

	/** @type {Map<any, EachItem>} */
	var items = new Map();

	var is_controlled = (flags & EACH_IS_CONTROLLED) !== 0;

	if (is_controlled) {
		var parent_node = /** @type {Element} */ (node);

		anchor = parent_node.appendChild(create_text());
	}

	/** @type {Effect | null} */
	var fallback = null;

	// TODO: ideally we could use derived for runes mode but because of the ability
	// to use a store which can be mutated, we can't do that here as mutating a store
	// will still result in the collection array being the same from the store
	var each_array = derived_safe_equal(() => {
		var collection = get_collection();

		return /** @type {V[]} */ (
			is_array(collection) ? collection : collection == null ? [] : array_from(collection)
		);
	});

	/** @type {V[]} */
	var array;

	/** @type {Map<Batch, Set<any>>} */
	var pending = new Map();

	var first_run = true;

	/**
	 * @param {Batch} batch
	 */
	function commit(batch) {
		if ((state.effect.f & DESTROYED) !== 0) {
			return;
		}

		state.pending.delete(batch);

		state.fallback = fallback;
		reconcile(state, array, anchor, flags, get_key);

		if (fallback !== null) {
			if (array.length === 0) {
				if ((fallback.f & EFFECT_OFFSCREEN) === 0) {
					resume_effect(fallback);
				} else {
					fallback.f ^= EFFECT_OFFSCREEN;
					move(fallback, null, anchor);
				}
			} else {
				pause_effect(fallback, () => {
					// TODO only null out if no pending batch needs it,
					// otherwise re-add `fallback.fragment` and move the
					// effect into it
					fallback = null;
				});
			}
		}
	}

	/**
	 * @param {Batch} batch
	 */
	function discard(batch) {
		state.pending.delete(batch);
	}

	var effect = block(() => {
		array = /** @type {V[]} */ (get(each_array));
		var length = array.length;

		var keys = new Set();
		var batch = /** @type {Batch} */ (current_batch);
		var defer = should_defer_append();

		for (var index = 0; index < length; index += 1) {

			var value = array[index];
			var key = get_key(value, index);

			var item = first_run ? null : items.get(key);

			if (item) {
				// update before reconciliation, to trigger any async updates
				if (item.v) internal_set(item.v, value);
				if (item.i) internal_set(item.i, index);

				if (defer) {
					batch.unskip_effect(item.e);
				}
			} else {
				item = create_item(
					items,
					first_run ? anchor : (offscreen_anchor ??= create_text()),
					value,
					key,
					index,
					render_fn,
					flags,
					get_collection
				);

				if (!first_run) {
					item.e.f |= EFFECT_OFFSCREEN;
				}

				items.set(key, item);
			}

			keys.add(key);
		}

		if (length === 0 && fallback_fn && !fallback) {
			if (first_run) {
				fallback = branch(() => fallback_fn(anchor));
			} else {
				fallback = branch(() => fallback_fn((offscreen_anchor ??= create_text())));
				fallback.f |= EFFECT_OFFSCREEN;
			}
		}

		if (length > keys.size) {
			{
				// in prod, the additional information isn't printed, so don't bother computing it
				each_key_duplicate();
			}
		}

		if (!first_run) {
			pending.set(batch, keys);

			if (defer) {
				for (const [key, item] of items) {
					if (!keys.has(key)) {
						batch.skip_effect(item.e);
					}
				}

				batch.oncommit(commit);
				batch.ondiscard(discard);
			} else {
				commit(batch);
			}
		}

		// When we mount the each block for the first time, the collection won't be
		// connected to this effect as the effect hasn't finished running yet and its deps
		// won't be assigned. However, it's possible that when reconciling the each block
		// that a mutation occurred and it's made the collection MAYBE_DIRTY, so reading the
		// collection again can provide consistency to the reactive graph again as the deriveds
		// will now be `CLEAN`.
		get(each_array);
	});

	/** @type {EachState} */
	var state = { effect, items, pending, outrogroups: null, fallback };

	first_run = false;
}

/**
 * Skip past any non-branch effects (which could be created with `createSubscriber`, for example) to find the next branch effect
 * @param {Effect | null} effect
 * @returns {Effect | null}
 */
function skip_to_branch(effect) {
	while (effect !== null && (effect.f & BRANCH_EFFECT) === 0) {
		effect = effect.next;
	}
	return effect;
}

/**
 * Add, remove, or reorder items output by an each block as its input changes
 * @template V
 * @param {EachState} state
 * @param {Array<V>} array
 * @param {Element | Comment | Text} anchor
 * @param {number} flags
 * @param {(value: V, index: number) => any} get_key
 * @returns {void}
 */
function reconcile(state, array, anchor, flags, get_key) {
	var is_animated = (flags & EACH_IS_ANIMATED) !== 0;

	var length = array.length;
	var items = state.items;
	var current = skip_to_branch(state.effect.first);

	/** @type {undefined | Set<Effect>} */
	var seen;

	/** @type {Effect | null} */
	var prev = null;

	/** @type {undefined | Set<Effect>} */
	var to_animate;

	/** @type {Effect[]} */
	var matched = [];

	/** @type {Effect[]} */
	var stashed = [];

	/** @type {V} */
	var value;

	/** @type {any} */
	var key;

	/** @type {Effect | undefined} */
	var effect;

	/** @type {number} */
	var i;

	if (is_animated) {
		for (i = 0; i < length; i += 1) {
			value = array[i];
			key = get_key(value, i);
			effect = /** @type {EachItem} */ (items.get(key)).e;

			// offscreen == coming in now, no animation in that case,
			// else this would happen https://github.com/sveltejs/svelte/issues/17181
			if ((effect.f & EFFECT_OFFSCREEN) === 0) {
				effect.nodes?.a?.measure();
				(to_animate ??= new Set()).add(effect);
			}
		}
	}

	for (i = 0; i < length; i += 1) {
		value = array[i];
		key = get_key(value, i);

		effect = /** @type {EachItem} */ (items.get(key)).e;

		if (state.outrogroups !== null) {
			for (const group of state.outrogroups) {
				group.pending.delete(effect);
				group.done.delete(effect);
			}
		}

		if ((effect.f & INERT) !== 0) {
			resume_effect(effect);
			if (is_animated) {
				effect.nodes?.a?.unfix();
				(to_animate ??= new Set()).delete(effect);
			}
		}

		if ((effect.f & EFFECT_OFFSCREEN) !== 0) {
			effect.f ^= EFFECT_OFFSCREEN;

			if (effect === current) {
				move(effect, null, anchor);
			} else {
				var next = prev ? prev.next : current;

				if (effect === state.effect.last) {
					state.effect.last = effect.prev;
				}

				if (effect.prev) effect.prev.next = effect.next;
				if (effect.next) effect.next.prev = effect.prev;
				link(state, prev, effect);
				link(state, effect, next);

				move(effect, next, anchor);
				prev = effect;

				matched = [];
				stashed = [];

				current = skip_to_branch(prev.next);
				continue;
			}
		}

		if (effect !== current) {
			if (seen !== undefined && seen.has(effect)) {
				if (matched.length < stashed.length) {
					// more efficient to move later items to the front
					var start = stashed[0];
					var j;

					prev = start.prev;

					var a = matched[0];
					var b = matched[matched.length - 1];

					for (j = 0; j < matched.length; j += 1) {
						move(matched[j], start, anchor);
					}

					for (j = 0; j < stashed.length; j += 1) {
						seen.delete(stashed[j]);
					}

					link(state, a.prev, b.next);
					link(state, prev, a);
					link(state, b, start);

					current = start;
					prev = b;
					i -= 1;

					matched = [];
					stashed = [];
				} else {
					// more efficient to move earlier items to the back
					seen.delete(effect);
					move(effect, current, anchor);

					link(state, effect.prev, effect.next);
					link(state, effect, prev === null ? state.effect.first : prev.next);
					link(state, prev, effect);

					prev = effect;
				}

				continue;
			}

			matched = [];
			stashed = [];

			while (current !== null && current !== effect) {
				(seen ??= new Set()).add(current);
				stashed.push(current);
				current = skip_to_branch(current.next);
			}

			if (current === null) {
				continue;
			}
		}

		if ((effect.f & EFFECT_OFFSCREEN) === 0) {
			matched.push(effect);
		}

		prev = effect;
		current = skip_to_branch(effect.next);
	}

	if (state.outrogroups !== null) {
		for (const group of state.outrogroups) {
			if (group.pending.size === 0) {
				destroy_effects(state, array_from(group.done));
				state.outrogroups?.delete(group);
			}
		}

		if (state.outrogroups.size === 0) {
			state.outrogroups = null;
		}
	}

	if (current !== null || seen !== undefined) {
		/** @type {Effect[]} */
		var to_destroy = [];

		if (seen !== undefined) {
			for (effect of seen) {
				if ((effect.f & INERT) === 0) {
					to_destroy.push(effect);
				}
			}
		}

		while (current !== null) {
			// If the each block isn't inert, then inert effects are currently outroing and will be removed once the transition is finished
			if ((current.f & INERT) === 0 && current !== state.fallback) {
				to_destroy.push(current);
			}

			current = skip_to_branch(current.next);
		}

		var destroy_length = to_destroy.length;

		if (destroy_length > 0) {
			var controlled_anchor = (flags & EACH_IS_CONTROLLED) !== 0 && length === 0 ? anchor : null;

			if (is_animated) {
				for (i = 0; i < destroy_length; i += 1) {
					to_destroy[i].nodes?.a?.measure();
				}

				for (i = 0; i < destroy_length; i += 1) {
					to_destroy[i].nodes?.a?.fix();
				}
			}

			pause_effects(state, to_destroy, controlled_anchor);
		}
	}

	if (is_animated) {
		queue_micro_task(() => {
			if (to_animate === undefined) return;
			for (effect of to_animate) {
				effect.nodes?.a?.apply();
			}
		});
	}
}

/**
 * @template V
 * @param {Map<any, EachItem>} items
 * @param {Node} anchor
 * @param {V} value
 * @param {unknown} key
 * @param {number} index
 * @param {(anchor: Node, item: V | Source<V>, index: number | Value<number>, collection: () => V[]) => void} render_fn
 * @param {number} flags
 * @param {() => V[]} get_collection
 * @returns {EachItem}
 */
function create_item(items, anchor, value, key, index, render_fn, flags, get_collection) {
	var v =
		(flags & EACH_ITEM_REACTIVE) !== 0
			? (flags & EACH_ITEM_IMMUTABLE) === 0
				? mutable_source(value, false, false)
				: source(value)
			: null;

	var i = (flags & EACH_INDEX_REACTIVE) !== 0 ? source(index) : null;

	return {
		v,
		i,
		e: branch(() => {
			render_fn(anchor, v ?? value, i ?? index, get_collection);

			return () => {
				items.delete(key);
			};
		})
	};
}

/**
 * @param {Effect} effect
 * @param {Effect | null} next
 * @param {Text | Element | Comment} anchor
 */
function move(effect, next, anchor) {
	if (!effect.nodes) return;

	var node = effect.nodes.start;
	var end = effect.nodes.end;

	var dest =
		next && (next.f & EFFECT_OFFSCREEN) === 0
			? /** @type {EffectNodes} */ (next.nodes).start
			: anchor;

	while (node !== null) {
		var next_node = /** @type {TemplateNode} */ (get_next_sibling(node));
		dest.before(node);

		if (node === end) {
			return;
		}

		node = next_node;
	}
}

/**
 * @param {EachState} state
 * @param {Effect | null} prev
 * @param {Effect | null} next
 */
function link(state, prev, next) {
	if (prev === null) {
		state.effect.first = next;
	} else {
		prev.next = next;
	}

	if (next === null) {
		state.effect.last = prev;
	} else {
		next.prev = prev;
	}
}

/** @import { Snippet } from 'svelte' */
/** @import { TemplateNode } from '#client' */
/** @import { Getters } from '#shared' */

/**
 * @template {(node: TemplateNode, ...args: any[]) => void} SnippetFn
 * @param {TemplateNode} node
 * @param {() => SnippetFn | null | undefined} get_snippet
 * @param {(() => any)[]} args
 * @returns {void}
 */
function snippet(node, get_snippet, ...args) {
	var branches = new BranchManager(node);

	block(() => {
		const snippet = get_snippet() ?? null;

		branches.ensure(snippet, snippet && ((anchor) => snippet(anchor, ...args)));
	}, EFFECT_TRANSPARENT);
}

/**
 * @param {Node} anchor
 * @param {{ hash: string, code: string }} css
 */
function append_styles$1(anchor, css) {
	// Use `queue_micro_task` to ensure `anchor` is in the DOM, otherwise getRootNode() will yield wrong results
	effect(() => {
		var root = anchor.getRootNode();

		var target = /** @type {ShadowRoot} */ (root).host
			? /** @type {ShadowRoot} */ (root)
			: /** @type {Document} */ (root).head ?? /** @type {Document} */ (root.ownerDocument).head;

		// Always querying the DOM is roughly the same perf as additionally checking for presence in a map first assuming
		// that you'll get cache hits half of the time, so we just always query the dom for simplicity and code savings.
		if (!target.querySelector('#' + css.hash)) {
			const style = create_element('style');
			style.id = css.hash;
			style.textContent = css.code;

			target.appendChild(style);
		}
	});
}

/** @import { Effect } from '#client' */

// TODO in 6.0 or 7.0, when we remove legacy mode, we can simplify this by
// getting rid of the block/branch stuff and just letting the effect rip.
// see https://github.com/sveltejs/svelte/pull/15962

/**
 * @param {Element} node
 * @param {() => (node: Element) => void} get_fn
 */
function attach(node, get_fn) {
	/** @type {false | undefined | ((node: Element) => void)} */
	var fn = undefined;

	/** @type {Effect | null} */
	var e;

	managed(() => {
		if (fn !== (fn = get_fn())) {
			if (e) {
				destroy_effect(e);
				e = null;
			}

			if (fn) {
				e = branch(() => {
					effect(() => /** @type {(node: Element) => void} */ (fn)(node));
				});
			}
		}
	});
}

function r(e){var t,f,n="";if("string"==typeof e||"number"==typeof e)n+=e;else if("object"==typeof e)if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++)e[t]&&(f=r(e[t]))&&(n&&(n+=" "),n+=f);}else for(f in e)e[f]&&(n&&(n+=" "),n+=f);return n}function clsx$1(){for(var e,t,f=0,n="",o=arguments.length;f<o;f++)(e=arguments[f])&&(t=r(e))&&(n&&(n+=" "),n+=t);return n}

/**
 * Small wrapper around clsx to preserve Svelte's (weird) handling of falsy values.
 * TODO Svelte 6 revisit this, and likely turn all falsy values into the empty string (what clsx also does)
 * @param  {any} value
 */
function clsx(value) {
	if (typeof value === 'object') {
		return clsx$1(value);
	} else {
		return value ?? '';
	}
}

const whitespace = [...' \t\n\r\f\u00a0\u000b\ufeff'];

/**
 * @param {any} value
 * @param {string | null} [hash]
 * @param {Record<string, boolean>} [directives]
 * @returns {string | null}
 */
function to_class(value, hash, directives) {
	var classname = value == null ? '' : '' + value;

	if (hash) {
		classname = classname ? classname + ' ' + hash : hash;
	}

	if (directives) {
		for (var key of Object.keys(directives)) {
			if (directives[key]) {
				classname = classname ? classname + ' ' + key : key;
			} else if (classname.length) {
				var len = key.length;
				var a = 0;

				while ((a = classname.indexOf(key, a)) >= 0) {
					var b = a + len;

					if (
						(a === 0 || whitespace.includes(classname[a - 1])) &&
						(b === classname.length || whitespace.includes(classname[b]))
					) {
						classname = (a === 0 ? '' : classname.substring(0, a)) + classname.substring(b + 1);
					} else {
						a = b;
					}
				}
			}
		}
	}

	return classname === '' ? null : classname;
}

/**
 *
 * @param {Record<string,any>} styles
 * @param {boolean} important
 */
function append_styles(styles, important = false) {
	var separator = important ? ' !important;' : ';';
	var css = '';

	for (var key of Object.keys(styles)) {
		var value = styles[key];
		if (value != null && value !== '') {
			css += ' ' + key + ': ' + value + separator;
		}
	}

	return css;
}

/**
 * @param {string} name
 * @returns {string}
 */
function to_css_name(name) {
	if (name[0] !== '-' || name[1] !== '-') {
		return name.toLowerCase();
	}
	return name;
}

/**
 * @param {any} value
 * @param {Record<string, any> | [Record<string, any>, Record<string, any>]} [styles]
 * @returns {string | null}
 */
function to_style(value, styles) {
	if (styles) {
		var new_style = '';

		/** @type {Record<string,any> | undefined} */
		var normal_styles;

		/** @type {Record<string,any> | undefined} */
		var important_styles;

		if (Array.isArray(styles)) {
			normal_styles = styles[0];
			important_styles = styles[1];
		} else {
			normal_styles = styles;
		}

		if (value) {
			value = String(value)
				.replaceAll(/\s*\/\*.*?\*\/\s*/g, '')
				.trim();

			/** @type {boolean | '"' | "'"} */
			var in_str = false;
			var in_apo = 0;
			var in_comment = false;

			var reserved_names = [];

			if (normal_styles) {
				reserved_names.push(...Object.keys(normal_styles).map(to_css_name));
			}
			if (important_styles) {
				reserved_names.push(...Object.keys(important_styles).map(to_css_name));
			}

			var start_index = 0;
			var name_index = -1;

			const len = value.length;
			for (var i = 0; i < len; i++) {
				var c = value[i];

				if (in_comment) {
					if (c === '/' && value[i - 1] === '*') {
						in_comment = false;
					}
				} else if (in_str) {
					if (in_str === c) {
						in_str = false;
					}
				} else if (c === '/' && value[i + 1] === '*') {
					in_comment = true;
				} else if (c === '"' || c === "'") {
					in_str = c;
				} else if (c === '(') {
					in_apo++;
				} else if (c === ')') {
					in_apo--;
				}

				if (!in_comment && in_str === false && in_apo === 0) {
					if (c === ':' && name_index === -1) {
						name_index = i;
					} else if (c === ';' || i === len - 1) {
						if (name_index !== -1) {
							var name = to_css_name(value.substring(start_index, name_index).trim());

							if (!reserved_names.includes(name)) {
								if (c !== ';') {
									i++;
								}

								var property = value.substring(start_index, i).trim();
								new_style += ' ' + property + ';';
							}
						}

						start_index = i + 1;
						name_index = -1;
					}
				}
			}
		}

		if (normal_styles) {
			new_style += append_styles(normal_styles);
		}

		if (important_styles) {
			new_style += append_styles(important_styles, true);
		}

		new_style = new_style.trim();
		return new_style === '' ? null : new_style;
	}

	return value == null ? null : String(value);
}

/**
 * @param {Element} dom
 * @param {boolean | number} is_html
 * @param {string | null} value
 * @param {string} [hash]
 * @param {Record<string, any>} [prev_classes]
 * @param {Record<string, any>} [next_classes]
 * @returns {Record<string, boolean> | undefined}
 */
function set_class(dom, is_html, value, hash, prev_classes, next_classes) {
	var prev = /** @type {any} */ (dom)[CLASS_CACHE];

	if (
		prev !== value ||
		prev === undefined // for edge case of `class={undefined}`
	) {
		var next_class_name = to_class(value, hash, next_classes);

		{
			// Removing the attribute when the value is only an empty string causes
			// performance issues vs simply making the className an empty string. So
			// we should only remove the class if the value is nullish
			// and there no hash/directives :
			if (next_class_name == null) {
				dom.removeAttribute('class');
			} else if (is_html) {
				dom.className = next_class_name;
			} else {
				dom.setAttribute('class', next_class_name);
			}
		}

		/** @type {any} */ (dom)[CLASS_CACHE] = value;
	} else if (next_classes && prev_classes !== next_classes) {
		for (var key in next_classes) {
			var is_present = !!next_classes[key];

			if (prev_classes == null || is_present !== !!prev_classes[key]) {
				dom.classList.toggle(key, is_present);
			}
		}
	}

	return next_classes;
}

/**
 * @param {Element & ElementCSSInlineStyle} dom
 * @param {Record<string, any>} prev
 * @param {Record<string, any>} next
 * @param {string} [priority]
 */
function update_styles(dom, prev = {}, next, priority) {
	for (var key in next) {
		var value = next[key];

		if (prev[key] !== value) {
			if (next[key] == null) {
				dom.style.removeProperty(key);
			} else {
				dom.style.setProperty(key, value, priority);
			}
		}
	}
}

/**
 * @param {Element & ElementCSSInlineStyle} dom
 * @param {string | null} value
 * @param {Record<string, any> | [Record<string, any>, Record<string, any>]} [prev_styles]
 * @param {Record<string, any> | [Record<string, any>, Record<string, any>]} [next_styles]
 */
function set_style(dom, value, prev_styles, next_styles) {
	var prev = /** @type {any} */ (dom)[STYLE_CACHE];

	if (prev !== value) {
		var next_style_attr = to_style(value, next_styles);

		{
			if (next_style_attr == null) {
				dom.removeAttribute('style');
			} else {
				dom.style.cssText = next_style_attr;
			}
		}

		/** @type {any} */ (dom)[STYLE_CACHE] = value;
	} else if (next_styles) {
		if (Array.isArray(next_styles)) {
			update_styles(dom, prev_styles?.[0], next_styles[0]);
			update_styles(dom, prev_styles?.[1], next_styles[1], 'important');
		} else {
			update_styles(dom, prev_styles, next_styles);
		}
	}

	return next_styles;
}

/**
 * Selects the correct option(s) (depending on whether this is a multiple select)
 * @template V
 * @param {HTMLSelectElement} select
 * @param {V} value
 * @param {boolean} mounting
 */
function select_option(select, value, mounting = false) {
	if (select.multiple) {
		// If value is null or undefined, keep the selection as is
		if (value == undefined) {
			return;
		}

		// If not an array, warn and keep the selection as is
		if (!is_array(value)) {
			return select_multiple_invalid_value();
		}

		// Otherwise, update the selection
		for (var option of select.options) {
			option.selected = value.includes(get_option_value(option));
		}

		return;
	}

	for (option of select.options) {
		var option_value = get_option_value(option);
		if (is(option_value, value)) {
			option.selected = true;
			return;
		}
	}

	if (!mounting || value !== undefined) {
		select.selectedIndex = -1; // no option should be selected
	}
}

/**
 * Selects the correct option(s) if `value` is given,
 * and then sets up a mutation observer to sync the
 * current selection to the dom when it changes. Such
 * changes could for example occur when options are
 * inside an `#each` block.
 * @param {HTMLSelectElement} select
 */
function init_select(select) {
	var observer = new MutationObserver(() => {
		// @ts-ignore
		select_option(select, select.__value);
		// Deliberately don't update the potential binding value,
		// the model should be preserved unless explicitly changed
	});

	observer.observe(select, {
		// Listen to option element changes
		childList: true,
		subtree: true, // because of <optgroup>
		// Listen to option element value attribute changes
		// (doesn't get notified of select value changes,
		// because that property is not reflected as an attribute)
		attributes: true,
		attributeFilter: ['value']
	});

	teardown(() => {
		observer.disconnect();
	});
}

/** @param {HTMLOptionElement} option */
function get_option_value(option) {
	// __value only exists if the <option> has a value attribute
	if ('__value' in option) {
		return option.__value;
	} else {
		return option.value;
	}
}

/** @import { Blocker, Effect } from '#client' */

const CLASS = Symbol('class');
const STYLE = Symbol('style');

const IS_CUSTOM_ELEMENT = Symbol('is custom element');
const IS_HTML = Symbol('is html');
const INPUT_TAG = IS_XHTML ? 'input' : 'INPUT';
const OPTION_TAG = IS_XHTML ? 'option' : 'OPTION';
const SELECT_TAG = IS_XHTML ? 'select' : 'SELECT';

/**
 * Sets the `selected` attribute on an `option` element.
 * Not set through the property because that doesn't reflect to the DOM,
 * which means it wouldn't be taken into account when a form is reset.
 * @param {HTMLOptionElement} element
 * @param {boolean} selected
 */
function set_selected(element, selected) {
	if (selected) {
		// The selected option could've changed via user selection, and
		// setting the value without this check would set it back.
		if (!element.hasAttribute('selected')) {
			element.setAttribute('selected', '');
		}
	} else {
		element.removeAttribute('selected');
	}
}

/**
 * @param {Element} element
 * @param {string} attribute
 * @param {string | null} value
 * @param {boolean} [skip_warning]
 */
function set_attribute(element, attribute, value, skip_warning) {
	var attributes = get_attributes(element);

	if (attributes[attribute] === (attributes[attribute] = value)) return;

	if (attribute === 'loading') {
		// @ts-expect-error
		element[LOADING_ATTR_SYMBOL] = value;
	}

	if (value == null) {
		element.removeAttribute(attribute);
	} else if (typeof value !== 'string' && get_setters(element).includes(attribute)) {
		// @ts-ignore
		element[attribute] = value;
	} else {
		element.setAttribute(attribute, value);
	}
}

/**
 * Spreads attributes onto a DOM element, taking into account the currently set attributes
 * @param {Element & ElementCSSInlineStyle} element
 * @param {Record<string | symbol, any> | undefined} prev
 * @param {Record<string | symbol, any>} next New attributes - this function mutates this object
 * @param {string} [css_hash]
 * @param {boolean} [should_remove_defaults]
 * @param {boolean} [skip_warning]
 * @returns {Record<string, any>}
 */
function set_attributes(
	element,
	prev,
	next,
	css_hash,
	should_remove_defaults = false,
	skip_warning = false
) {

	var attributes = get_attributes(element);

	var is_custom_element = attributes[IS_CUSTOM_ELEMENT];
	var preserve_attribute_case = !attributes[IS_HTML];

	var current = prev || {};
	var is_option_element = element.nodeName === OPTION_TAG;

	for (var key in prev) {
		if (!(key in next)) {
			next[key] = null;
		}
	}

	if (next.class) {
		next.class = clsx(next.class);
	} else {
		next.class = null; /* force call to set_class() */
	}

	if (next[STYLE]) {
		next.style ??= null; /* force call to set_style() */
	}

	var setters = get_setters(element);

	if (element.nodeName === INPUT_TAG && 'type' in next && ('value' in next || '__value' in next)) {
		var type = next.type;

		if (type !== current.type || (type === undefined && element.hasAttribute('type'))) {
			current.type = type;
			set_attribute(element, 'type', type);
		}
	}

	// since key is captured we use const
	for (const key in next) {
		// let instead of var because referenced in a closure
		let value = next[key];

		// Up here because we want to do this for the initial value, too, even if it's undefined,
		// and this wouldn't be reached in case of undefined because of the equality check below
		if (is_option_element && key === 'value' && value == null) {
			// The <option> element is a special case because removing the value attribute means
			// the value is set to the text content of the option element, and setting the value
			// to null or undefined means the value is set to the string "null" or "undefined".
			// To align with how we handle this case in non-spread-scenarios, this logic is needed.
			// There's a super-edge-case bug here that is left in in favor of smaller code size:
			// Because of the "set missing props to null" logic above, we can't differentiate
			// between a missing value and an explicitly set value of null or undefined. That means
			// that once set, the value attribute of an <option> element can't be removed. This is
			// a very rare edge case, and removing the attribute altogether isn't possible either
			// for the <option value={undefined}> case, so we're not losing any functionality here.
			// @ts-ignore
			element.value = element.__value = '';
			current[key] = value;
			continue;
		}

		if (key === 'class') {
			var is_html = element.namespaceURI === 'http://www.w3.org/1999/xhtml';
			set_class(element, is_html, value, css_hash, prev?.[CLASS], next[CLASS]);
			current[key] = value;
			current[CLASS] = next[CLASS];
			continue;
		}

		if (key === 'style') {
			set_style(element, value, prev?.[STYLE], next[STYLE]);
			current[key] = value;
			current[STYLE] = next[STYLE];
			continue;
		}

		var prev_value = current[key];

		// Skip if value is unchanged, unless it's `undefined` and the element still has the attribute
		if (value === prev_value && !(value === undefined && element.hasAttribute(key))) {
			continue;
		}

		current[key] = value;

		var prefix = key[0] + key[1]; // this is faster than key.slice(0, 2)
		if (prefix === '$$') continue;

		if (prefix === 'on') {
			/** @type {{ capture?: true }} */
			const opts = {};
			const event_handle_key = '$$' + key;
			let event_name = key.slice(2);
			var is_delegated = can_delegate_event(event_name);

			if (is_capture_event(event_name)) {
				event_name = event_name.slice(0, -7);
				opts.capture = true;
			}

			if (!is_delegated && prev_value) {
				// Listening to same event but different handler -> our handle function below takes care of this
				// If we were to remove and add listeners in this case, it could happen that the event is "swallowed"
				// (the browser seems to not know yet that a new one exists now) and doesn't reach the handler
				// https://github.com/sveltejs/svelte/issues/11903
				if (value != null) continue;

				element.removeEventListener(event_name, current[event_handle_key], opts);
				current[event_handle_key] = null;
			}

			if (is_delegated) {
				delegated(event_name, element, value);
				delegate([event_name]);
			} else if (value != null) {
				/**
				 * @this {any}
				 * @param {Event} evt
				 */
				function handle(evt) {
					current[key].call(this, evt);
				}

				current[event_handle_key] = create_event(event_name, element, handle, opts);
			}
		} else if (key === 'style') {
			// avoid using the setter
			set_attribute(element, key, value);
		} else if (key === 'autofocus') {
			autofocus(/** @type {HTMLElement} */ (element), Boolean(value));
		} else if (!is_custom_element && (key === '__value' || (key === 'value' && value != null))) {
			// @ts-ignore We're not running this for custom elements because __value is actually
			// how Lit stores the current value on the element, and messing with that would break things.
			element.value = element.__value = value;
		} else if (key === 'selected' && is_option_element) {
			set_selected(/** @type {HTMLOptionElement} */ (element), value);
		} else {
			var name = key;
			if (!preserve_attribute_case) {
				name = normalize_attribute(name);
			}

			var is_default = name === 'defaultValue' || name === 'defaultChecked';

			if (value == null && !is_custom_element && !is_default) {
				attributes[key] = null;

				if (name === 'value' || name === 'checked') {
					// removing value/checked also removes defaultValue/defaultChecked — preserve
					let input = /** @type {HTMLInputElement} */ (element);
					const use_default = prev === undefined;
					if (name === 'value') {
						let previous = input.defaultValue;
						input.removeAttribute(name);
						input.defaultValue = previous;
						// @ts-ignore
						input.value = input.__value = use_default ? previous : null;
					} else {
						let previous = input.defaultChecked;
						input.removeAttribute(name);
						input.defaultChecked = previous;
						input.checked = use_default ? previous : false;
					}
				} else {
					element.removeAttribute(key);
				}
			} else if (
				is_default ||
				(setters.includes(name) && (is_custom_element || typeof value !== 'string'))
			) {
				// @ts-ignore
				element[name] = value;
				// remove it from attributes's cache
				if (name in attributes) attributes[name] = UNINITIALIZED;
			} else if (typeof value !== 'function') {
				set_attribute(element, name, value);
			}
		}
	}

	return current;
}

/**
 * @param {Element & ElementCSSInlineStyle} element
 * @param {(...expressions: any) => Record<string | symbol, any>} fn
 * @param {Array<() => any>} sync
 * @param {Array<() => Promise<any>>} async
 * @param {Blocker[]} blockers
 * @param {string} [css_hash]
 * @param {boolean} [should_remove_defaults]
 * @param {boolean} [skip_warning]
 */
function attribute_effect(
	element,
	fn,
	sync = [],
	async = [],
	blockers = [],
	css_hash,
	should_remove_defaults = false,
	skip_warning = false
) {
	flatten(blockers, sync, async, (values) => {
		/** @type {Record<string | symbol, any> | undefined} */
		var prev = undefined;

		/** @type {Record<symbol, Effect>} */
		var effects = {};

		var is_select = element.nodeName === SELECT_TAG;
		var inited = false;

		managed(() => {
			var next = fn(...values.map(get));
			/** @type {Record<string | symbol, any>} */
			var current = set_attributes(
				element,
				prev,
				next,
				css_hash,
				should_remove_defaults,
				skip_warning
			);

			if (inited && is_select && 'value' in next) {
				select_option(/** @type {HTMLSelectElement} */ (element), next.value);
			}

			for (let symbol of Object.getOwnPropertySymbols(effects)) {
				if (!next[symbol]) destroy_effect(effects[symbol]);
			}

			for (let symbol of Object.getOwnPropertySymbols(next)) {
				var n = next[symbol];

				if (symbol.description === ATTACHMENT_KEY && (!prev || n !== prev[symbol])) {
					if (effects[symbol]) destroy_effect(effects[symbol]);
					effects[symbol] = branch(() => attach(element, () => n));
				}

				current[symbol] = n;
			}

			prev = current;
		});

		if (is_select) {
			var select = /** @type {HTMLSelectElement} */ (element);

			effect(() => {
				select_option(select, /** @type {Record<string | symbol, any>} */ (prev).value, true);
				init_select(select);
			});
		}

		inited = true;
	});
}

/**
 *
 * @param {Element} element
 */
function get_attributes(element) {
	return /** @type {Record<string | symbol, unknown>} **/ (
		/** @type {any} */ (element)[ATTRIBUTES_CACHE] ??= {
			[IS_CUSTOM_ELEMENT]: element.nodeName.includes('-'),
			[IS_HTML]: element.namespaceURI === NAMESPACE_HTML
		}
	);
}

/** @type {Map<string, string[]>} */
var setters_cache = new Map();

/** @param {Element} element */
function get_setters(element) {
	var cache_key = element.getAttribute('is') || element.nodeName;
	var setters = setters_cache.get(cache_key);
	if (setters) return setters;
	setters_cache.set(cache_key, (setters = []));

	var descriptors;
	var proto = element; // In the case of custom elements there might be setters on the instance
	var element_proto = Element.prototype;

	// Stop at Element, from there on there's only unnecessary (and dangerous, like innerHTML) setters we're not interested in
	// Do not use constructor.name here as that's unreliable in some browser environments
	while (element_proto !== proto) {
		descriptors = get_descriptors(proto);

		for (var key in descriptors) {
			if (
				descriptors[key].set &&
				// better safe than sorry, we don't want spread attributes to mess with HTML content
				key !== 'innerHTML' &&
				key !== 'textContent' &&
				key !== 'innerText'
			) {
				setters.push(key);
			}
		}

		proto = get_prototype_of(proto);
	}

	return setters;
}

/** @import { Derived, Effect, Source } from './types.js' */

/**
 * The proxy handler for spread props. Handles the incoming array of props
 * that looks like `() => { dynamic: props }, { static: prop }, ..` and wraps
 * them so that the whole thing is passed to the component as the `$$props` argument.
 * @type {ProxyHandler<{ props: Array<Record<string | symbol, unknown> | (() => Record<string | symbol, unknown>)> }>}}
 */
const spread_props_handler = {
	get(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) return p[key];
		}
	},
	set(target, key, value) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			const desc = get_descriptor(p, key);
			if (desc && desc.set) {
				desc.set(value);
				return true;
			}
		}
		return false;
	},
	getOwnPropertyDescriptor(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) {
				const descriptor = get_descriptor(p, key);
				if (descriptor && !descriptor.configurable) {
					// Prevent a "Non-configurability Report Error": The target is an array, it does
					// not actually contain this property. If it is now described as non-configurable,
					// the proxy throws a validation error. Setting it to true avoids that.
					descriptor.configurable = true;
				}
				return descriptor;
			}
		}
	},
	has(target, key) {
		// To prevent a false positive `is_entry_props` in the `prop` function
		if (key === STATE_SYMBOL || key === LEGACY_PROPS) return false;

		for (let p of target.props) {
			if (is_function(p)) p = p();
			if (p != null && key in p) return true;
		}

		return false;
	},
	ownKeys(target) {
		/** @type {Array<string | symbol>} */
		const keys = [];

		for (let p of target.props) {
			if (is_function(p)) p = p();
			if (!p) continue;

			for (const key in p) {
				if (!keys.includes(key)) keys.push(key);
			}

			for (const key of Object.getOwnPropertySymbols(p)) {
				if (!keys.includes(key)) keys.push(key);
			}
		}

		return keys;
	}
};

/**
 * @param {Array<Record<string, unknown> | (() => Record<string, unknown>)>} props
 * @returns {any}
 */
function spread_props(...props) {
	return new Proxy({ props }, spread_props_handler);
}

/**
 * This function is responsible for synchronizing a possibly bound prop with the inner component state.
 * It is used whenever the compiler sees that the component writes to the prop, or when it has a default prop_value.
 * @template V
 * @param {Record<string, unknown>} props
 * @param {string} key
 * @param {number} flags
 * @param {V | (() => V)} [fallback]
 * @returns {(() => V | ((arg: V) => V) | ((arg: V, mutation: boolean) => V))}
 */
function prop(props, key, flags, fallback) {
	var runes = true;
	var bindable = (flags & PROPS_IS_BINDABLE) !== 0;
	var lazy = (flags & PROPS_IS_LAZY_INITIAL) !== 0;

	var fallback_value = /** @type {V} */ (fallback);
	var fallback_dirty = true;
	var fallback_signal = /** @type {Derived<V> | undefined} */ (undefined);

	var get_fallback = () => {
		if (lazy && runes) {
			fallback_signal ??= derived(/** @type {() => V} */ (fallback));
			return get(fallback_signal);
		}

		if (fallback_dirty) {
			fallback_dirty = false;

			fallback_value = lazy
				? untrack(/** @type {() => V} */ (fallback))
				: /** @type {V} */ (fallback);
		}

		return fallback_value;
	};

	/** @type {((v: V) => void) | undefined} */
	let setter;

	if (bindable) {
		// Can be the case when someone does `mount(Component, props)` with `let props = $state({...})`
		// or `createClassComponent(Component, props)`
		var is_entry_props = STATE_SYMBOL in props || LEGACY_PROPS in props;

		setter =
			get_descriptor(props, key)?.set ??
			(is_entry_props && key in props ? (v) => (props[key] = v) : undefined);
	}

	/** @type {V} */
	var initial_value;
	var is_store_sub = false;

	if (bindable) {
		[initial_value, is_store_sub] = capture_store_binding(() => /** @type {V} */ (props[key]));
	} else {
		initial_value = /** @type {V} */ (props[key]);
	}

	if (initial_value === undefined && fallback !== undefined) {
		initial_value = get_fallback();

		if (setter) {
			props_invalid_value();
			setter(initial_value);
		}
	}

	/** @type {() => V} */
	var getter;

	{
		getter = () => {
			var value = /** @type {V} */ (props[key]);
			if (value === undefined) return get_fallback();
			fallback_dirty = true;
			return value;
		};
	}

	// prop is never written to — we only need a getter
	if ((flags & PROPS_IS_UPDATED) === 0) {
		return getter;
	}

	// prop is written to, but the parent component had `bind:foo` which
	// means we can just call `$$props.foo = value` directly
	if (setter) {
		var legacy_parent = props.$$legacy;
		return /** @type {() => V} */ (
			function (/** @type {V} */ value, /** @type {boolean} */ mutation) {
				if (arguments.length > 0) {
					// We don't want to notify if the value was mutated and the parent is in runes mode.
					// In that case the state proxy (if it exists) should take care of the notification.
					// If the parent is not in runes mode, we need to notify on mutation, too, that the prop
					// has changed because the parent will not be able to detect the change otherwise.
					if (!mutation || legacy_parent || is_store_sub) {
						/** @type {Function} */ (setter)(mutation ? getter() : value);
					}

					return value;
				}

				return getter();
			}
		);
	}

	// Either prop is written to, but there's no binding, which means we
	// create a derived that we can write to locally.
	// Or we are in legacy mode where we always create a derived to replicate that
	// Svelte 4 did not trigger updates when a primitive value was updated to the same value.
	var overridden = false;

	var d = ((flags & PROPS_IS_IMMUTABLE) !== 0 ? derived : derived_safe_equal)(() => {
		overridden = false;
		return getter();
	});

	// Capture the initial value if it's bindable
	if (bindable) get(d);

	var parent_effect = /** @type {Effect} */ (active_effect);

	return /** @type {() => V} */ (
		function (/** @type {any} */ value, /** @type {boolean} */ mutation) {
			if (arguments.length > 0) {
				const new_value = mutation ? get(d) : bindable ? proxy(value) : value;

				set(d, new_value);
				overridden = true;

				if (fallback_value !== undefined) {
					fallback_value = new_value;
				}

				return value;
			}

			// special case — avoid recalculating the derived if we're in a
			// teardown function and the prop was overridden locally, or the
			// component was already destroyed (people could access props in a timeout)
			if ((is_destroying_effect && overridden) || (parent_effect.f & DESTROYED) !== 0) {
				return d.v;
			}

			return get(d);
		}
	);
}

class ConfirmationModal extends obsidian.Modal {
    constructor(app, config) {
        super(app);
        const { cta, onAccept, text, title } = config;
        this.contentEl.createEl("h2", { text: title });
        this.contentEl.createEl("p", { text });
        this.contentEl.createDiv("modal-button-container", (buttonsEl) => {
            buttonsEl
                .createEl("button", { text: "Never mind" })
                .addEventListener("click", () => this.close());
            buttonsEl
                .createEl("button", {
                cls: "mod-cta",
                text: cta,
            })
                .addEventListener("click", () => {
                void (async () => {
                    // Always close, even if onAccept rejects (e.g. a create collision);
                    // otherwise the modal is stuck open and the rejection is unhandled.
                    try {
                        await onAccept();
                    }
                    finally {
                        this.close();
                    }
                })();
            });
        });
    }
}
function createConfirmationDialog({ cta, onAccept, text, title, }) {
    new ConfirmationModal(window.app, { cta, onAccept, text, title }).open();
}

const PERIODICITY_LABELS = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
};
// Tracks in-flight `create()` invocations per (periodicity, date) UID so that
// rapid duplicate clicks for the same periodic note don't race on vault.create
// and produce a stray "Unable to create new file" Notice. Lock is acquired at
// create-time and released in a finally block so failures don't leave it stuck.
const inFlight = new Set();
/**
 * Create a periodic note on disk for the given date and return the new
 * `TFile`. Does not open the file — that is the caller's responsibility.
 *
 * Reads format/folder/template only from the supplied per-period settings.
 *
 * Throws on file-create failure (after showing a Notice) so callers can avoid
 * post-creation work like opening a leaf.
 */
async function createPeriodicNote(periodicity, date, perPeriodSettings) {
    var _a;
    const path = getPeriodicNotePath(perPeriodSettings, date);
    await ensureParentFolderExists(path);
    const { contents: rawTemplate, foldInfo } = await getTemplateInfo(perPeriodSettings.template);
    const expanded = applyTemplateTokens(rawTemplate, periodicity, date, perPeriodSettings.format);
    const { vault } = window.app;
    let createdFile;
    try {
        createdFile = await vault.create(path, expanded);
    }
    catch (err) {
        console.error(`[Calendar] Failed to create file: '${path}'`, err);
        new obsidian.Notice("Unable to create new file.");
        throw err;
    }
    if (foldInfo) {
        (_a = window.app.foldManager) === null || _a === void 0 ? void 0 : _a.save(createdFile, foldInfo);
    }
    return createdFile;
}
/**
 * Create a periodic note with the same confirm-before-create UX the existing
 * per-period IO files use. The optional callback fires after a successful
 * create so callers can open / focus. The callback is awaited, so async
 * callbacks (e.g. openFile then update active-file state) complete before
 * this function resolves.
 */
async function tryToCreatePeriodicNote(periodicity, date, settings, cb) {
    const perPeriod = settings[periodicity];
    const filename = date.format(perPeriod.format);
    const key = getDateUID(date, periodicity);
    const create = async () => {
        if (inFlight.has(key))
            return;
        inFlight.add(key);
        try {
            const file = await createPeriodicNote(periodicity, date, perPeriod);
            await (cb === null || cb === void 0 ? void 0 : cb(file));
        }
        finally {
            inFlight.delete(key);
        }
    };
    if (settings.shouldConfirmBeforeCreate) {
        createConfirmationDialog({
            cta: "Create",
            onAccept: create,
            text: `File ${filename} does not exist. Would you like to create it?`,
            title: `New ${PERIODICITY_LABELS[periodicity]} Note`,
        });
    }
    else {
        await create();
    }
}
/**
 * Pick the destination leaf for a click on a periodic-note target.
 * Plain click → current pane. Modifier + tab-setting → new tab.
 * Modifier + !tab-setting → vertical split.
 */
function getLeafForModifierClick(ctrlPressed, settings, workspace) {
    if (!ctrlPressed)
        return workspace.getLeaf(false);
    return settings.ctrlClickOpensInNewTab
        ? workspace.getLeaf("tab")
        : workspace.getLeaf("split", "vertical");
}
/**
 * Create a periodic note (with confirm-before-create UX) and open it in the
 * leaf chosen by the modifier-click logic. Optional callback fires after the
 * file is opened, useful for caller-side activeFile bookkeeping.
 */
async function tryToCreatePeriodicNoteAndOpen(periodicity, date, ctrlPressed, settings, cb) {
    await tryToCreatePeriodicNote(periodicity, date, settings, async (newFile) => {
        const { workspace } = window.app;
        const leaf = getLeafForModifierClick(ctrlPressed, settings, workspace);
        await leaf.openFile(newFile, { active: true });
        cb === null || cb === void 0 ? void 0 : cb(newFile);
    });
}

function tryToCreateDailyNote(date, ctrlPressed, settings, cb) {
    return tryToCreatePeriodicNoteAndOpen("daily", date, ctrlPressed, settings, cb);
}

function tryToCreateWeeklyNote(date, ctrlPressed, settings, cb) {
    return tryToCreatePeriodicNoteAndOpen("weekly", date, ctrlPressed, settings, cb);
}

function tryToCreateMonthlyNote(date, ctrlPressed, settings, cb) {
    return tryToCreatePeriodicNoteAndOpen("monthly", date, ctrlPressed, settings, cb);
}

function tryToCreateYearlyNote(date, ctrlPressed, settings, cb) {
    return tryToCreatePeriodicNoteAndOpen("yearly", date, ctrlPressed, settings, cb);
}

function tryToCreateQuarterlyNote(date, ctrlPressed, settings, cb) {
    return tryToCreatePeriodicNoteAndOpen("quarterly", date, ctrlPressed, settings, cb);
}

const IMAGE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif",
]);
function isImagePath(path) {
    var _a, _b;
    const ext = (_b = (_a = path.split(".").pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : "";
    return IMAGE_EXTENSIONS.has(ext);
}
function extractLinkpath(raw) {
    // Strip ![[...]], [[...]], display aliases (|alias), and bare "..." wrappers
    return raw
        .replace(/^!?\[\[(.+?)(?:\|[^\]]*)?]]$/, "$1")
        .replace(/^"(.+)"$/, "$1")
        .trim();
}
const fileCache = new Map();
function resolveFeatureImageFile(note, app, frontmatterProperties) {
    const propsKey = frontmatterProperties.join(" ");
    const cached = fileCache.get(note.path);
    if (cached && cached.mtime === note.stat.mtime && cached.propsKey === propsKey) {
        return cached.file;
    }
    const file = resolveUncached(note, app, frontmatterProperties);
    fileCache.set(note.path, { mtime: note.stat.mtime, propsKey, file });
    return file;
}
/**
 * Drop the cached resolution for a note. Call this when its metadata changes
 * (the `metadataCache` "changed" event) so the next resolve re-reads the
 * updated cache. Necessary because the cache key includes `mtime`, but the
 * `vault.modify` event bumps `mtime` *before* the metadata cache is reparsed —
 * so a resolve triggered by `modify` can store a stale entry under the new
 * mtime, which a later metadata-change tick would then return (e.g. removing
 * the last image from a note left the featured image showing until reload).
 */
function invalidateFeatureImageCache(path) {
    fileCache.delete(path);
}
/**
 * Drop cached resolutions that point at a given *image* file. Call this when
 * the image itself is deleted or renamed: the memo is keyed by the referencing
 * *note's* path/mtime, so an image-file event wouldn't otherwise invalidate it,
 * leaving a note cached as resolving to a now-dead `TFile` (broken/blank cell
 * until the note is next edited).
 */
function invalidateFeatureImageCacheForImage(imagePath) {
    var _a;
    for (const [notePath, entry] of fileCache) {
        if (((_a = entry.file) === null || _a === void 0 ? void 0 : _a.path) === imagePath)
            fileCache.delete(notePath);
    }
}
function resolveUncached(note, app, frontmatterProperties) {
    const cache = app.metadataCache.getFileCache(note);
    if (!cache)
        return null;
    // `FrontMatterCache` indexes to `any`; pull each property out into an
    // explicitly-`unknown` local so the access is type-safe (the reviewer's
    // no-unsafe-* rules flag `any`).
    const fm = cache.frontmatter;
    if (fm) {
        for (const prop of frontmatterProperties) {
            const value = fm[prop.trim()];
            // A list-valued property (YAML sequence) arrives as an array — use its
            // first entry. Single-string values pass through unchanged.
            const raw = Array.isArray(value) ? value[0] : value;
            if (typeof raw !== "string")
                continue;
            const linkpath = extractLinkpath(raw);
            if (!isImagePath(linkpath))
                continue;
            const imageFile = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
            if (imageFile instanceof obsidian.TFile) {
                return imageFile;
            }
        }
    }
    if (cache.embeds) {
        for (const embed of cache.embeds) {
            const linkpath = embed.link.split("|")[0];
            if (!isImagePath(linkpath))
                continue;
            const imageFile = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
            if (imageFile instanceof obsidian.TFile) {
                return imageFile;
            }
        }
    }
    return null;
}

// generated during release, do not modify

const PUBLIC_VERSION = '5';

if (typeof window !== 'undefined') {
	// @ts-expect-error
	((window.__svelte ??= {}).v ??= new Set()).add(PUBLIC_VERSION);
}

var root$7 = from_svg(`<svg viewBox="0 0 6 6" xmlns="http://www.w3.org/2000/svg"><circle cx="3" cy="3" r="2"></circle></svg>`);

const $$css$6 = {
	hash: 'svelte-1taai4i',
	code: '.dot.svelte-1taai4i,\n  .hollow.svelte-1taai4i {display:inline-block;height:6px;width:6px;margin:0 1px;}.filled.svelte-1taai4i {fill:var(--color-dot);}.hollow.svelte-1taai4i {fill:none;stroke:var(--color-dot);}'
};

function Dot($$anchor, $$props) {
	append_styles$1($$anchor, $$css$6);

	let className = prop($$props, 'className', 3, "");
	var fragment = comment();
	var node = first_child(fragment);

	{
		var consequent = ($$anchor) => {
			var svg = root$7();

			template_effect(() => set_class(svg, 0, `dot filled ${className()}`, 'svelte-1taai4i'));
			append($$anchor, svg);
		};

		var alternate = ($$anchor) => {
			var svg_1 = root$7();

			template_effect(() => set_class(svg_1, 0, `hollow ${className()}`, 'svelte-1taai4i'));
			append($$anchor, svg_1);
		};

		if_block(node, ($$render) => {
			if ($$props.isFilled) $$render(consequent); else $$render(alternate, -1);
		});
	}

	append($$anchor, fragment);
}

function MetadataResolver($$anchor, $$props) {
	push($$props, true);

	// When there's no metadata promise, hand the snippet an empty metadata
	// object rather than null, so consumers always receive a non-null
	// IDayMetadata.
	const emptyMeta = { classes: [], dots: [], dataAttributes: {} };

	// Resolve the metadata promise into reactive state and render it directly,
	// rather than via `{#await}`. The parent produces a *new* metadata promise on
	// every calendar tick (settings change, file event, sync, heartbeat, …), and
	// `{#await}` tears down and recreates its rendered content each time it's
	// handed a new promise. For feature-image cells that meant the background
	// `<div>` was destroyed and recreated on every tick — forcing the browser to
	// reload and recomposite the image, a major source of lag while typing or
	// syncing with featured images enabled. Resolving into `$state` and rendering
	// it once lets Svelte diff the cell's attributes in place: when the resolved
	// values are unchanged (same dots, same image URL), the DOM — and the image —
	// is left untouched. It also avoids the blank flash `{#await}` showed while a
	// new promise was pending (the previous value stays until the next resolves).
	let resolved = state(proxy(emptyMeta));

	user_effect(() => {
		const pending = $$props.metadata;

		if (!pending) {
			set(resolved, emptyMeta, true);

			return;
		}

		let cancelled = false;

		void pending.then((meta) => {
			if (!cancelled) set(resolved, meta, true);
		});

		return () => {
			cancelled = true;
		};
	});

	var fragment = comment();
	var node = first_child(fragment);

	snippet(node, () => $$props.children, () => get(resolved));
	append($$anchor, fragment);
	pop();
}

function isMetaPressed(e) {
    return obsidian.Platform.isMacOS ? e.metaKey : e.ctrlKey;
}
// Option (macOS) / Alt (Windows/Linux). Cross-platform via the single
// `altKey` flag. Used on day cells to open an existing second daily note.
function isAltPressed(e) {
    return e.altKey;
}
function getDaysOfWeek(..._args) {
    return moment.weekdaysShort(true);
}
/**
 * Returns true when the given date falls on one of the configured weekend
 * days. `weekendDays` carries JS/Moment weekday numbers
 * (0 = Sunday … 6 = Saturday); the lookup uses `date.day()` which is in the
 * same index space. Independent of locale week-start.
 */
function isWeekend(date, weekendDays) {
    return weekendDays.includes(date.day());
}
function getStartOfWeek(days) {
    return days[0].weekday(0);
}
/**
 * Clamp `num` to the inclusive range [lowerBound, upperBound].
 * Ported from the original Calendar plugin's `src/ui/utils.ts`
 * (https://github.com/liamcain/obsidian-calendar-plugin), MIT.
 */
function clamp(num, lowerBound, upperBound) {
    return Math.min(Math.max(lowerBound, num), upperBound);
}
/**
 * Count words in a text blob using a regex that handles space-delimited
 * scripts (Latin + extended) and non-space-delimited CJK scripts.
 * Ported verbatim from the original Calendar plugin's `src/ui/utils.ts`
 * (https://github.com/liamcain/obsidian-calendar-plugin), MIT.
 */
function getWordCount(text) {
    var _a;
    const spaceDelimitedChars = /A-Za-zªµºÀ-ÖØ-öø-ˁˆ-ˑˠ-ˤˬˮͰ-ʹͶͷͺ-ͽͿΆΈ-ΊΌΎ-ΡΣ-ϵϷ-ҁҊ-ԯԱ-Ֆՙա-ևא-תװ-ײؠ-يٮٯٱ-ۓەۥۦۮۯۺ-ۼۿܐܒ-ܯݍ-ޥޱߊ-ߪߴߵߺࠀ-ࠕࠚࠤࠨࡀ-ࡘࢠ-ࢴऄ-हऽॐक़-ॡॱ-ঀঅ-ঌএঐও-নপ-রলশ-হঽৎড়ঢ়য়-ৡৰৱਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઍએ-ઑઓ-નપ-રલળવ-હઽૐૠૡૹଅ-ଌଏଐଓ-ନପ-ରଲଳଵ-ହଽଡ଼ଢ଼ୟ-ୡୱஃஅ-ஊஎ-ஐஒ-கஙசஜஞடணதந-பம-ஹௐఅ-ఌఎ-ఐఒ-నప-హఽౘ-ౚౠౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಽೞೠೡೱೲഅ-ഌഎ-ഐഒ-ഺഽൎൟ-ൡൺ-ൿඅ-ඖක-නඳ-රලව-ෆก-ะาำเ-ๆກຂຄງຈຊຍດ-ທນ-ຟມ-ຣລວສຫອ-ະາຳຽເ-ໄໆໜ-ໟༀཀ-ཇཉ-ཬྈ-ྌက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎႠ-ჅჇჍა-ჺჼ-ቈቊ-ቍቐ-ቖቘቚ-ቝበ-ኈኊ-ኍነ-ኰኲ-ኵኸ-ኾዀዂ-ዅወ-ዖዘ-ጐጒ-ጕጘ-ፚᎀ-ᎏᎠ-Ᏽᏸ-ᏽᐁ-ᙬᙯ-ᙿᚁ-ᚚᚠ-ᛪᛱ-ᛸᜀ-ᜌᜎ-ᜑᜠ-ᜱᝀ-ᝑᝠ-ᝬᝮ-ᝰក-ឳៗៜᠠ-ᡷᢀ-ᢨᢪᢰ-ᣵᤀ-ᤞᥐ-ᥭᥰ-ᥴᦀ-ᦫᦰ-ᧉᨀ-ᨖᨠ-ᩔᪧᬅ-ᬳᭅ-ᭋᮃ-ᮠᮮᮯᮺ-ᯥᰀ-ᰣᱍ-ᱏᱚ-ᱽᳩ-ᳬᳮ-ᳱᳵᳶᴀ-ᶿḀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼⁱⁿₐ-ₜℂℇℊ-ℓℕℙ-ℝℤΩℨK-ℭℯ-ℹℼ-ℿⅅ-ⅉⅎↃↄⰀ-Ⱞⰰ-ⱞⱠ-ⳤⳫ-ⳮⳲⳳⴀ-ⴥⴧⴭⴰ-ⵧⵯⶀ-ⶖⶠ-ⶦⶨ-ⶮⶰ-ⶶⶸ-ⶾⷀ-ⷆⷈ-ⷎⷐ-ⷖⷘ-ⷞⸯ々〆〱-〵〻〼ㄅ-ㄭㄱ-ㆎㆠ-ㆺㇰ-ㇿ㐀-䶵ꀀ-ꒌꓐ-ꓽꔀ-ꘌꘐ-ꘟꘪꘫꙀ-ꙮꙿ-ꚝꚠ-ꛥꜗ-ꜟꜢ-ꞈꞋ-ꞭꞰ-ꞷꟷ-ꠁꠃ-ꠅꠇ-ꠊꠌ-ꠢꡀ-ꡳꢂ-ꢳꣲ-ꣷꣻꣽꤊ-ꤥꤰ-ꥆꥠ-ꥼꦄ-ꦲꧏꧠ-ꧤꧦ-ꧯꧺ-ꧾꨀ-ꨨꩀ-ꩂꩄ-ꩋꩠ-ꩶꩺꩾ-ꪯꪱꪵꪶꪹ-ꪽꫀꫂꫛ-ꫝꫠ-ꫪꫲ-ꫴꬁ-ꬆꬉ-ꬎꬑ-ꬖꬠ-ꬦꬨ-ꬮꬰ-ꭚꭜ-ꭥꭰ-ꯢ가-힣ힰ-ퟆퟋ-ퟻ豈-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-ﬨשׁ-זּטּ-לּמּנּסּףּפּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-ﷻﹰ-ﹴﹶ-ﻼＡ-Ｚａ-ｚｦ-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ/
        .source;
    const nonSpaceDelimitedWords = /ぁ-ゖゝ-ゟァ-ヺー-ヿ一-鿕/
        .source;
    const pattern = new RegExp([
        `(?:[0-9]+(?:(?:,|\\.)[0-9]+)*|[\\-${spaceDelimitedChars}])+`,
        nonSpaceDelimitedWords,
    ].join("|"), "g");
    return ((_a = text.match(pattern)) !== null && _a !== void 0 ? _a : []).length;
}
/**
 * Generate a 2D array of daily information to power
 * the calendar view.
 */
function getMonth(displayedMonth, ..._args) {
    const locale = moment().locale();
    const month = [];
    let week = { days: [], weekNum: 0 };
    const startOfMonth = displayedMonth.clone().locale(locale).date(1);
    const startOffset = startOfMonth.weekday();
    let date = startOfMonth.clone().subtract(startOffset, "days");
    for (let _day = 0; _day < 42; _day++) {
        if (_day % 7 === 0) {
            week = {
                days: [],
                weekNum: date.week(),
            };
            month.push(week);
        }
        week.days.push(date);
        date = date.clone().add(1, "days");
    }
    return month;
}

var root$6 = from_html(`<div><span class="day-number svelte-x62535"> </span> <div class="dot-container svelte-x62535"></div></div>`);
var root_1$4 = from_html(`<td><!></td>`);

const $$css$5 = {
	hash: 'svelte-x62535',
	code: '.day.svelte-x62535 {background-color:var(--color-background-day);border-radius:4px;color:var(--color-text-day);cursor:pointer;font-size:0.8em;height:100%;\n    /* isolation: isolate creates a stacking context so ::before/::after\n       z-index values are resolved within .day, not the document root.\n       This lets z-index: 0 overlays sit above the background image but\n       below z-index: 1 text and dots. */isolation:isolate;padding:4px;position:relative;text-align:center;transition:background-color 0.1s ease-in, color 0.1s ease-in;vertical-align:baseline;}.day.svelte-x62535:hover {background-color:var(--interactive-hover);}.day.active.svelte-x62535:hover {background-color:var(--interactive-accent-hover);}.adjacent-month.svelte-x62535 {opacity:0.25;}.today.svelte-x62535 {color:var(--color-text-today);}.day.svelte-x62535:active,\n  .day.active.svelte-x62535,\n  .day.active.today.svelte-x62535 {color:var(--text-on-accent);background-color:var(--interactive-accent);}\n\n  /* The second daily note for this day is the active file. Use a neutral grey\n     overlay (distinct from the accent fill used for the primary daily note) so\n     it reads as selected without competing with the purple. Implemented as a\n     translucent ::after so it works the same over plain cells and feature-image\n     cells; sits above the cell background / image (z-index: 0) but below the\n     number and dots (z-index: 1). The `.active` class is suppressed on these\n     cells (see the markup), so the two highlights never stack. */.day.second-daily-active.svelte-x62535::after {content:\'\';position:absolute;inset:0;border-radius:4px;background-color:var(--text-muted);opacity:0.4;pointer-events:none;z-index:0;}\n\n  /* Today\'s number is normally accent-colored (--color-text-today); under the\n     grey second-daily overlay that reads as out-of-place purple, so restore\n     the normal day text color to match every other second-daily-active cell.\n     (The primary-active state has the analogous `.day.active.today` override.) */.day.second-daily-active.today.svelte-x62535 {color:var(--color-text-day);}\n\n  /* Featured image support ------------------------------------------------ */.day.has-background-image.svelte-x62535 {background-size:cover;background-position:center;overflow:hidden;}\n\n  /* Readability overlay: a dark gradient in front of the image so the date\n     number and dots are visible regardless of photo content. Kept heavy on\n     purpose — the goal is an at-a-glance "this day has an image" cue, not to\n     show photo detail. z-index: 0 sits above the background image but below\n     .day-number / .dot-container (z-index: 1 within the isolation context). */.day.has-background-image.svelte-x62535::before {content:\'\';position:absolute;inset:0;border-radius:4px;background:linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.35));pointer-events:none;transition:background 0.1s ease-in;z-index:0;}\n\n  /* Hover over an image cell: the base `.day:hover` background-color is hidden\n     behind the photo, so instead lighten the ::before overlay (the photo\n     appears to brighten). Keeping background-color stable (transparent) avoids\n     a repaint that re-composites the image on every hover — that was the\n     source of hover lag on image-heavy vaults. */.day.has-background-image.svelte-x62535:hover,\n  .day.has-background-image.active.svelte-x62535:hover {background-color:transparent;}.day.has-background-image.svelte-x62535:hover::before {background:linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1));}\n\n  /* Active state over an image: suppress the solid accent background and\n     use a translucent accent overlay instead so the photo stays visible\n     underneath while the cell still reads as selected. */.day.has-background-image.active.svelte-x62535,\n  .day.has-background-image.active.today.svelte-x62535,\n  .day.has-background-image.svelte-x62535:active {background-color:transparent;}.day.has-background-image.active.svelte-x62535::after,\n  .day.has-background-image.active.today.svelte-x62535::after,\n  .day.has-background-image.svelte-x62535:active::after {content:\'\';position:absolute;inset:0;background-color:var(--interactive-accent);border-radius:4px;opacity:0.65;pointer-events:none;z-index:0;}\n\n  /* The number is wrapped in a span purely for z-index: it must sit above\n     both overlays within the isolation stacking context. No visual styling\n     here — color, weight, and the today/active rules all come from the\n     existing .day / .today / .day.active.today rules and inherit through the\n     span, so the number looks identical whether or not the cell has an image. */.day-number.svelte-x62535 {position:relative;z-index:1;}.dot-container.svelte-x62535 {display:flex;flex-wrap:wrap;justify-content:center;line-height:6px;min-height:6px;position:relative;z-index:1;}'
};

function Day($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css$5);

	let // Properties
		// Global state
		displayedMonth = prop($$props, 'displayedMonth', 3, null),
		selectedId = prop($$props, 'selectedId', 3, null),
		selectedSecondDailyId = prop($$props, 'selectedSecondDailyId', 3, null),
		weekendDays = prop($$props, 'weekendDays', 19, () => [0, 6]);

	const isWeekendDay = user_derived(() => isWeekend($$props.date, weekendDays()));
	const dailyUid = user_derived(() => getDateUID($$props.date, "daily"));
	const isSecondDailyActive = user_derived(() => selectedSecondDailyId() === get(dailyUid));
	var td = root_1$4();
	let classes;
	var node = child(td);

	{
		const children = ($$anchor, metadata = noop) => {
			var div = root$6();

			attribute_effect(
				div,
				($0, $1) => ({
					class: $0,
					style: metadata().backgroundImage
						? `background-image: url("${metadata().backgroundImage}")`
						: "",
					onclick: $$props.onClick && ((e) => $$props.onClick($$props.date, isMetaPressed(e), isAltPressed(e))),
					oncontextmenu: $$props.onContextMenu && ((e) => $$props.onContextMenu($$props.date, e)),
					onpointerover: $$props.onHover && ((e) => $$props.onHover($$props.date, e.currentTarget, isMetaPressed(e))),
					...metadata().dataAttributes || {},
					[CLASS]: $1
				}),
				[
					() => `day ${(metadata().classes ?? []).join(" ")}`,
					() => ({
						active: selectedId() === get(dailyUid) && !get(isSecondDailyActive),
						'second-daily-active': get(isSecondDailyActive),
						'adjacent-month': displayedMonth() && !$$props.date.isSame(displayedMonth(), "month"),
						today: $$props.date.isSame($$props.today, "day"),
						'has-background-image': !!metadata().backgroundImage
					})
				],
				void 0,
				void 0,
				'svelte-x62535'
			);

			var span = child(div);
			var text = child(span);

			var div_1 = sibling(span, 2);

			each(div_1, 21, () => metadata().dots ?? [], index, ($$anchor, dot) => {
				Dot($$anchor, spread_props(() => get(dot)));
			});
			template_effect(($0) => set_text(text, $0), [() => $$props.date.format("D")]);
			append($$anchor, div);
		};

		MetadataResolver(node, {
			get metadata() {
				return $$props.metadata;
			},
			children,
			$$slots: { default: true }
		});
	}
	template_effect(() => classes = set_class(td, 1, '', null, classes, { weekend: get(isWeekendDay) }));
	append($$anchor, td);
	pop();
}

var root$5 = from_html(`<div><svg focusable="false" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512" class="svelte-5izuqg"><path fill="currentColor" d="M34.52 239.03L228.87 44.69c9.37-9.37 24.57-9.37 33.94 0l22.67 22.67c9.36 9.36 9.37 24.52.04 33.9L131.49 256l154.02 154.75c9.34 9.38 9.32 24.54-.04 33.9l-22.67 22.67c-9.37 9.37-24.57 9.37-33.94 0L34.52 272.97c-9.37-9.37-9.37-24.57 0-33.94z"></path></svg></div>`);

const $$css$4 = {
	hash: 'svelte-5izuqg',
	code: '.arrow.svelte-5izuqg {align-items:center;cursor:pointer;display:flex;justify-content:center;width:24px;}.arrow.svelte-5izuqg:hover {opacity:0.7;}.arrow.is-mobile.svelte-5izuqg {width:32px;}.right.svelte-5izuqg {transform:rotate(180deg);}.arrow.svelte-5izuqg svg:where(.svelte-5izuqg) {color:var(--color-arrow);height:16px;width:16px;}'
};

function Arrow($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css$4);

	const isMobile = obsidian.Platform.isMobile;
	var div = root$5();
	let classes;

	template_effect(() => classes = set_class(div, 1, 'arrow svelte-5izuqg', null, classes, { 'is-mobile': isMobile, right: $$props.direction === "right" }));

	delegated('click', div, function (...$$args) {
		$$props.onClick?.apply(this, $$args);
	});

	append($$anchor, div);
	pop();
}

delegate(['click']);

var root$4 = from_html(`<span class="divider svelte-hunw0s">•</span>`);
var root_1$3 = from_html(`<span> </span> <!>`, 1);
var root_2$1 = from_html(`<div class="quarters svelte-hunw0s"></div>`);
var root_3$1 = from_html(`<div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svelte-hunw0s"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg></div>`);
var root_4$1 = from_html(`<div class="reset-button svelte-hunw0s"> </div>`);
var root_5$1 = from_html(`<div><div class="title-container svelte-hunw0s"><h3 class="title svelte-hunw0s"><span class="month svelte-hunw0s"> </span> <span class="year svelte-hunw0s"> </span></h3> <!></div> <div class="right-nav svelte-hunw0s"><!> <!> <!> <!></div></div>`);

const $$css$3 = {
	hash: 'svelte-hunw0s',
	code: '.nav.svelte-hunw0s {align-items:center;display:flex;margin:0.6em 0 1em;padding:0 8px;width:100%;}.nav.is-mobile.svelte-hunw0s {\n    /* Match desktop left padding so the mobile title aligns with the grid. */padding:0 0 0 8px;}.title-container.svelte-hunw0s {display:flex;flex-direction:column;align-items:flex-start;}.title.svelte-hunw0s {color:var(--color-text-title);font-size:1.5em;margin:0;}.is-mobile.svelte-hunw0s .title:where(.svelte-hunw0s) {font-size:1.3em;}.month.svelte-hunw0s {font-weight:500;text-transform:capitalize;cursor:pointer;}.year.svelte-hunw0s {color:var(--interactive-accent);cursor:pointer;}.quarters.svelte-hunw0s {display:flex;align-items:center;margin-top:4px;\n    /* 2px optical nudge to the right — sits the cluster just inside the\n       month title\'s left edge instead of perfectly flush, which reads\n       better at this font size. Not restoring the old per-item margins\n       or container padding (those caused the larger 6px indent). */margin-left:2px;\n    /* gap replaces per-item horizontal margins + the container\'s side\n       padding. The previous setup gave Q1 a 4px margin-left plus 2px of\n       container padding-left, leaving the row visually indented relative\n       to the month title (which has margin: 0). Using gap puts the first\n       child flush at the container\'s left edge while preserving the same\n       6px spacing between adjacent items (was 4px quarter-margin + 2px\n       divider-margin = 6px between each quarter and its divider). */gap:6px;}.quarter.svelte-hunw0s {font-size:0.6em;color:var(--text-muted);cursor:pointer;}.quarter.active.svelte-hunw0s {color:var(--interactive-accent);font-weight:bold;\n    /* Background / pill defenses against theme overrides (e.g. Minimal)\n       live in styles.css with a `#calendar-container` ID prefix — Svelte\'s\n       component-scoped specificity (0,4,0) isn\'t enough to beat a theme\n       targeting generic `.active` with higher specificity. */}.divider.svelte-hunw0s {font-size:0.4em;color:var(--text-muted);}.right-nav.svelte-hunw0s {display:flex;justify-content:center;align-items:center;margin-left:auto;}.reset-button.svelte-hunw0s {cursor:pointer;border-radius:4px;color:var(--text-muted);font-size:0.7em;font-weight:600;letter-spacing:1px;margin:0 4px;padding:0 4px;text-transform:uppercase;}.reset-button.svelte-hunw0s:hover {opacity:0.7;}.year-overview-toggle.svelte-hunw0s {align-items:center;cursor:pointer;display:flex;justify-content:center;width:24px;}.year-overview-toggle.svelte-hunw0s:hover {opacity:0.7;}.is-mobile.svelte-hunw0s .year-overview-toggle:where(.svelte-hunw0s) {width:32px;}\n\n  /* Light grey when off, brightening to the normal (white-ish) text color\n     when the panel is open, so the icon\'s state is legible without color. */.year-overview-toggle.svelte-hunw0s svg:where(.svelte-hunw0s) {color:var(--text-muted);height:15px;width:15px;}.year-overview-toggle.active.svelte-hunw0s svg:where(.svelte-hunw0s) {color:var(--text-normal);}'
};

function Nav($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css$3);

	let // Optional Today-click callback. When provided, the Today button jumps to
		// the current month *and* invokes this with `today` so the parent can open
		// or create today's daily note via the same path day-cell clicks use.
		onClickToday = prop($$props, 'onClickToday', 3, undefined),
		// Mobile-only opt-in: render the Today button in the mobile header. Off
		// by default to keep the mobile header uncrowded. Desktop always shows
		// the Today button regardless of this prop.
		showTodayButtonOnMobile = prop($$props, 'showTodayButtonOnMobile', 3, false),
		// Year overview: `showYearOverviewButton` gates whether the history button
		// renders (the persisted setting); `yearOverviewOpen` drives its active
		// styling (the transient popup state); `onToggleYearOverview` opens/closes.
		showYearOverviewButton = prop($$props, 'showYearOverviewButton', 3, false),
		yearOverviewOpen = prop($$props, 'yearOverviewOpen', 3, false),
		onToggleYearOverview = prop($$props, 'onToggleYearOverview', 3, undefined);

	// Get the word 'Today' but localized to the current language
	const todayDisplayStr = user_derived(() => $$props.today.calendar().split(/\d|\s/)[0]);

	const isMobile = obsidian.Platform.isMobile;

	// Function to determine the current quarter
	function getCurrentQuarter(month) {
		return Math.floor(month / 3) + 1;
	}

	// Function to get the start of a quarter
	function getStartOfQuarter(year, quarter) {
		const startMonth = (quarter - 1) * 3; // Calculate the starting month of the quarter

		return $$props.displayedMonth.clone().year(year).month(startMonth).startOf("month");
	}

	const currentQuarter = user_derived(() => getCurrentQuarter($$props.displayedMonth.month()));
	var div = root_5$1();
	let classes;
	var div_1 = child(div);
	var h3 = child(div_1);
	var span = child(h3);
	var text = child(span);

	var span_1 = sibling(span, 2);
	var text_1 = child(span_1);

	var node = sibling(h3, 2);

	{
		var consequent_1 = ($$anchor) => {
			var div_2 = root_2$1();

			each(div_2, 20, () => [1, 2, 3, 4], index, ($$anchor, quarter, index) => {
				var fragment = root_1$3();
				var span_2 = first_child(fragment);
				let classes_1;
				var text_2 = child(span_2);

				var node_1 = sibling(span_2, 2);

				{
					var consequent = ($$anchor) => {
						var span_3 = root$4();

						append($$anchor, span_3);
					};

					if_block(node_1, ($$render) => {
						if (index < 3) $$render(consequent);
					});
				}

				template_effect(() => {
					classes_1 = set_class(span_2, 1, 'quarter svelte-hunw0s', null, classes_1, { active: quarter === get(currentQuarter) });
					set_text(text_2, `Q${quarter ?? ''}`);
				});

				delegated('click', span_2, (event) => $$props.onClickQuarter(getStartOfQuarter($$props.displayedMonth.year(), quarter), isMetaPressed(event)));
				append($$anchor, fragment);
			});
			append($$anchor, div_2);
		};

		if_block(node, ($$render) => {
			if ($$props.quarterVisible) $$render(consequent_1);
		});
	}

	var div_3 = sibling(div_1, 2);
	var node_2 = child(div_3);

	{
		var consequent_2 = ($$anchor) => {
			var div_4 = root_3$1();
			let classes_2;

			template_effect(() => classes_2 = set_class(div_4, 1, 'year-overview-toggle svelte-hunw0s', null, classes_2, { active: yearOverviewOpen() }));

			delegated('click', div_4, (e) => {
				e.stopPropagation();
				onToggleYearOverview()?.();
			});

			append($$anchor, div_4);
		};

		if_block(node_2, ($$render) => {
			if (showYearOverviewButton()) $$render(consequent_2);
		});
	}

	var node_3 = sibling(node_2, 2);

	Arrow(node_3, {
		direction: 'left',
		get onClick() {
			return $$props.decrementDisplayedMonth;
		}
	});

	var node_4 = sibling(node_3, 2);

	{
		var consequent_3 = ($$anchor) => {
			var div_5 = root_4$1();
			var text_3 = child(div_5);
			template_effect(() => set_text(text_3, get(todayDisplayStr)));

			delegated('click', div_5, () => {
				$$props.resetDisplayedMonth();
				onClickToday()?.($$props.today);
			});

			append($$anchor, div_5);
		};

		if_block(node_4, ($$render) => {
			if (!isMobile || showTodayButtonOnMobile()) $$render(consequent_3);
		});
	}

	var node_5 = sibling(node_4, 2);

	Arrow(node_5, {
		direction: 'right',
		get onClick() {
			return $$props.incrementDisplayedMonth;
		}
	});

	template_effect(
		($0, $1) => {
			classes = set_class(div, 1, 'nav svelte-hunw0s', null, classes, { 'is-mobile': isMobile });
			set_text(text, $0);
			set_text(text_1, $1);
		},
		[
			() => $$props.displayedMonth.format("MMM"),
			() => $$props.displayedMonth.format("YYYY")
		]
	);

	delegated('click', span, (event) => {
		$$props.onClickMonth($$props.displayedMonth, isMetaPressed(event));
	});

	delegated('click', span_1, (event) => {
		$$props.onClickYear($$props.displayedMonth, isMetaPressed(event));
	});

	append($$anchor, div);
	pop();
}

delegate(['click']);

var root$3 = from_html(`<div><span class="week-num-number svelte-18k3ixf"> </span> <div class="dot-container svelte-18k3ixf"></div></div>`);
var root_1$2 = from_html(`<td><!></td>`);

const $$css$2 = {
	hash: 'svelte-18k3ixf',
	code: 'td.grid-right.svelte-18k3ixf {border-right:1px solid var(--background-modifier-border);}.week-num.svelte-18k3ixf {background-color:var(--color-background-weeknum);border-radius:4px;color:var(--color-text-weeknum);cursor:pointer;font-size:0.8em;height:100%;isolation:isolate;padding:4px;position:relative;text-align:center;transition:background-color 0.1s ease-in,\n      color 0.1s ease-in;vertical-align:baseline;}.week-num.svelte-18k3ixf:hover {background-color:var(--interactive-hover);}.week-num.active.svelte-18k3ixf {color:var(--text-on-accent);background-color:var(--interactive-accent);}.week-num.active.svelte-18k3ixf:hover {background-color:var(--interactive-accent-hover);}\n\n  /* Featured image support ------------------------------------------------ */.week-num.has-background-image.svelte-18k3ixf {background-size:cover;background-position:center;overflow:hidden;}.week-num.has-background-image.svelte-18k3ixf::before {content:\'\';position:absolute;inset:0;border-radius:4px;background:linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.35));pointer-events:none;transition:background 0.1s ease-in;z-index:0;}\n\n  /* Hover over an image cell: lighten the ::before overlay (photo appears to\n     brighten) and keep background-color stable to avoid re-compositing the\n     image on hover. Mirrors Day.svelte. */.week-num.has-background-image.svelte-18k3ixf:hover,\n  .week-num.has-background-image.active.svelte-18k3ixf:hover {background-color:transparent;}.week-num.has-background-image.svelte-18k3ixf:hover::before {background:linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1));}.week-num.has-background-image.active.svelte-18k3ixf {background-color:transparent;}.week-num.has-background-image.active.svelte-18k3ixf::after {content:\'\';position:absolute;inset:0;background-color:var(--interactive-accent);border-radius:4px;opacity:0.65;pointer-events:none;z-index:0;}\n\n  /* Wrapped purely for z-index (sits above the overlays). No visual styling\n     here — the number looks identical whether or not the cell has an image. */.week-num-number.svelte-18k3ixf {position:relative;z-index:1;}\n\n  /* Reserve consistent space so week numbers don\'t shift vertically when a\n     weekly-note dot appears or disappears. */.dot-container.svelte-18k3ixf {display:flex;flex-wrap:wrap;justify-content:center;min-height:6px;position:relative;z-index:1;}'
};

function WeekNum($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css$2);

	let // Properties
	// Event handlers
	// Global state
	selectedId = prop($$props, 'selectedId', 3, null);

	const startOfWeek = user_derived(() => getStartOfWeek($$props.days));
	var td = root_1$2();
	let classes;
	var node = child(td);

	{
		const children = ($$anchor, metadata = noop) => {
			var div = root$3();
			let classes_1;
			var span = child(div);
			var text = child(span);

			var div_1 = sibling(span, 2);

			each(div_1, 21, () => metadata().dots ?? [], index, ($$anchor, dot) => {
				Dot($$anchor, spread_props(() => get(dot)));
			});

			template_effect(
				($0, $1) => {
					classes_1 = set_class(div, 1, $0, 'svelte-18k3ixf', classes_1, $1);

					set_style(div, metadata().backgroundImage
						? `background-image: url("${metadata().backgroundImage}")`
						: "");

					set_text(text, $$props.weekNum);
				},
				[
					() => `week-num ${(metadata().classes ?? []).join(" ")}`,
					() => ({
						active: selectedId() === getDateUID($$props.days[0], "weekly"),
						'has-background-image': !!metadata().backgroundImage
					})
				]
			);

			delegated('click', div, function (...$$args) {
				($$props.onClick && ((e) => $$props.onClick(get(startOfWeek), isMetaPressed(e))))?.apply(this, $$args);
			});

			delegated('contextmenu', div, function (...$$args) {
				($$props.onContextMenu && ((e) => $$props.onContextMenu($$props.days[0], e)))?.apply(this, $$args);
			});

			delegated('pointerover', div, function (...$$args) {
				($$props.onHover && ((e) => $$props.onHover(get(startOfWeek), e.currentTarget, isMetaPressed(e))))?.apply(this, $$args);
			});

			append($$anchor, div);
		};

		MetadataResolver(node, {
			get metadata() {
				return $$props.metadata;
			},
			children,
			$$slots: { default: true }
		});
	}
	template_effect(() => classes = set_class(td, 1, 'svelte-18k3ixf', null, classes, { 'grid-right': $$props.gridRight }));
	append($$anchor, td);
	pop();
}

delegate(['click', 'contextmenu', 'pointerover']);

var root$2 = from_html(`<div><span class="month-label svelte-1jpeose"> </span> <div class="dot-container svelte-1jpeose"><!></div></div>`);
var root_1$1 = from_html(`<div class="year-overview svelte-1jpeose"><div class="year-nav svelte-1jpeose"><!> <span class="year-label svelte-1jpeose"> </span> <!></div> <div class="months svelte-1jpeose"></div></div>`);

const $$css$1 = {
	hash: 'svelte-1jpeose',
	code: '\n  /* Rendered inside the year-overview popup card, which supplies the frame\n     and padding — so no border/margin here. */.year-overview.svelte-1jpeose {user-select:none;}.year-nav.svelte-1jpeose {align-items:center;display:flex;justify-content:center;gap:6px;margin-bottom:8px;}.year-label.svelte-1jpeose {color:var(--color-text-title);font-size:0.95em;font-weight:600;font-variant-numeric:tabular-nums;min-width:3em;text-align:center;}.months.svelte-1jpeose {display:grid;grid-template-columns:repeat(4, 1fr);gap:3px;}\n\n  /* Mirror .day styling (compact) so month cells feel like day cells. */.month-cell.svelte-1jpeose {align-items:center;background-color:var(--color-background-day);border-radius:4px;color:var(--color-text-day);cursor:pointer;display:flex;flex-direction:column;justify-content:center;padding:5px 4px 3px;text-align:center;transition:background-color 0.1s ease-in, color 0.1s ease-in;}.month-cell.svelte-1jpeose:hover {background-color:var(--interactive-hover);}.month-cell.today.svelte-1jpeose {color:var(--color-text-today);}.month-cell.active.svelte-1jpeose {color:var(--text-on-accent);background-color:var(--interactive-accent);}.month-cell.active.svelte-1jpeose:hover {background-color:var(--interactive-accent-hover);}.month-label.svelte-1jpeose {font-size:0.8em;text-transform:capitalize;}\n\n  /* Reserve space so the row height doesn\'t shift when a dot appears. */.dot-container.svelte-1jpeose {display:flex;flex-wrap:wrap;justify-content:center;line-height:6px;min-height:6px;margin-top:2px;}'
};

function YearGrid($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css$1);

	let // Global state
	monthsWithNotes = prop($$props, 'monthsWithNotes', 19, () => []);

	// Event handlers
	// Localized short month names, Jan..Dec (index = month number).
	const monthLabels = user_derived(() => moment.monthsShort());

	const displayedYear = user_derived(() => $$props.displayedMonth.year());
	const isCurrentYear = user_derived(() => get(displayedYear) === $$props.today.year());
	var div = root_1$1();
	var div_1 = child(div);
	var node = child(div_1);

	Arrow(node, {
		direction: 'left',
		get onClick() {
			return $$props.decrementDisplayedYear;
		}
	});

	var span = sibling(node, 2);
	var text = child(span);

	var node_1 = sibling(span, 2);

	Arrow(node_1, {
		direction: 'right',
		get onClick() {
			return $$props.incrementDisplayedYear;
		}
	});

	var div_2 = sibling(div_1, 2);

	each(div_2, 21, () => get(monthLabels), index, ($$anchor, label, i) => {
		var div_3 = root$2();
		let classes;
		var span_1 = child(div_3);
		var text_1 = child(span_1);

		var div_4 = sibling(span_1, 2);
		var node_2 = child(div_4);

		{
			var consequent = ($$anchor) => {
				Dot($$anchor, { isFilled: true });
			};

			if_block(node_2, ($$render) => {
				if (monthsWithNotes()[i]) $$render(consequent);
			});
		}

		template_effect(
			($0) => {
				classes = set_class(div_3, 1, 'month-cell svelte-1jpeose', null, classes, $0);
				set_text(text_1, get(label));
			},
			[
				() => ({
					active: i === $$props.displayedMonth.month(),
					today: get(isCurrentYear) && i === $$props.today.month()
				})
			]
		);

		delegated('click', div_3, () => $$props.onSelectMonth($$props.displayedMonth.clone().month(i).startOf("month")));
		append($$anchor, div_3);
	});
	template_effect(() => set_text(text, get(displayedYear)));
	append($$anchor, div);
	pop();
}

delegate(['click']);

async function metadataReducer(promisedMetadata) {
    const initial = {
        dots: [],
        classes: [],
        dataAttributes: {},
    };
    // A single source that rejects (e.g. a failed cachedRead) must not reject the
    // whole cell's metadata — that would leave the cell's rendered state stale
    // (MetadataResolver has no rejection path) and log an unhandled rejection.
    // Treat a failed source as contributing nothing.
    const metas = await Promise.all(promisedMetadata.map((p) => p.catch(() => ({ dots: [], classes: [], dataAttributes: {} }))));
    return metas.reduce((acc, meta) => {
        var _a, _b, _c, _d, _e, _f, _g;
        return ({
            classes: [...((_a = acc.classes) !== null && _a !== void 0 ? _a : []), ...((_b = meta.classes) !== null && _b !== void 0 ? _b : [])],
            dataAttributes: Object.assign(Object.assign({}, ((_c = acc.dataAttributes) !== null && _c !== void 0 ? _c : {})), ((_d = meta.dataAttributes) !== null && _d !== void 0 ? _d : {})),
            dots: [...((_e = acc.dots) !== null && _e !== void 0 ? _e : []), ...((_f = meta.dots) !== null && _f !== void 0 ? _f : [])],
            // First source that provides a backgroundImage wins; later sources don't override.
            backgroundImage: (_g = acc.backgroundImage) !== null && _g !== void 0 ? _g : meta.backgroundImage,
        });
    }, initial);
}
function getDailyMetadata(sources, date, ..._args) {
    return metadataReducer(sources.map((source) => { var _a, _b; return (_b = (_a = source.getDailyMetadata) === null || _a === void 0 ? void 0 : _a.call(source, date)) !== null && _b !== void 0 ? _b : Promise.resolve({}); }));
}
function getWeeklyMetadata(sources, date, ..._args) {
    return metadataReducer(sources.map((source) => { var _a, _b; return (_b = (_a = source.getWeeklyMetadata) === null || _a === void 0 ? void 0 : _a.call(source, date)) !== null && _b !== void 0 ? _b : Promise.resolve({}); }));
}

var root$1 = from_html(`<div class="year-popup svelte-1cv5gx"><!></div>`);
var root_1 = from_html(`<col/>`);
var root_2 = from_html(`<th class="week-num-heading svelte-1cv5gx">W</th>`);
var root_3 = from_html(`<th> </th>`);
var root_4 = from_html(`<tr><!><!><!></tr>`);
var root_5 = from_html(`<div id="calendar-container"><!> <!> <table class="calendar svelte-1cv5gx"><colgroup><!><!></colgroup><thead><tr><!><!><!></tr></thead><tbody></tbody></table></div>`);

const $$css = {
	hash: 'svelte-1cv5gx',
	code: '.container.svelte-1cv5gx {--color-background-heading: transparent;--color-background-day: transparent;--color-background-weeknum: transparent;--color-background-weekend: var(--color-base-25);--color-dot: var(--text-muted);--color-arrow: var(--text-muted);--color-button: var(--text-muted);--color-text-title: var(--text-normal);--color-text-heading: var(--text-muted);--color-text-day: var(--text-normal);--color-text-today: var(--interactive-accent);--color-text-weeknum: var(--text-muted);}.container.svelte-1cv5gx {padding:0 8px;\n    /* Anchor the absolutely-positioned year-overview popup. */position:relative;user-select:none;}.container.is-mobile.svelte-1cv5gx {padding:0;}\n\n  /* Year-overview popup: floats over the calendar, anchored under the\n     header history button. Click-away closes it (handled in script). */.year-popup.svelte-1cv5gx {position:absolute;top:42px;right:8px;z-index:20;width:220px;max-width:calc(100% - 16px);padding:8px 10px 10px;background-color:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;box-shadow:var(--shadow-s);}.container.is-mobile.svelte-1cv5gx .year-popup:where(.svelte-1cv5gx) {right:0;}th.svelte-1cv5gx {text-align:center;}.calendar.svelte-1cv5gx {border-collapse:collapse;table-layout:fixed;width:100%;}.week-num-heading.svelte-1cv5gx {width:10%;}th.svelte-1cv5gx {background-color:var(--color-background-heading);color:var(--color-text-heading);font-size:0.6em;letter-spacing:1px;padding:4px;text-transform:uppercase;}'
};

function Calendar$1($$anchor, $$props) {
	push($$props, true);
	append_styles$1($$anchor, $$css);

	let // Localization
		// Settings
		showWeekNums = prop($$props, 'showWeekNums', 3, false),
		showWeekNumsRight = prop($$props, 'showWeekNumsRight', 3, false),
		// JS weekday numbers (0 = Sunday … 6 = Saturday) treated as weekend days
		// for the `class:weekend` binding on header and body cells. Independent of
		// week-start ordering.
		weekendDays = prop($$props, 'weekendDays', 19, () => [0, 6]),
		// Event handlers
		onClickToday = prop($$props, 'onClickToday', 3, undefined),
		showTodayButtonOnMobile = prop($$props, 'showTodayButtonOnMobile', 3, false),
		// Year overview: when true, render the history button in the header that
		// opens the 12-month grid as a popup. `monthsWithNotes` drives the
		// per-month "has any note" dot.
		showYearOverview = prop($$props, 'showYearOverview', 3, false),
		monthsWithNotes = prop($$props, 'monthsWithNotes', 19, () => []),
		// External sources (all optional)
		sources = prop($$props, 'sources', 19, () => []),
		selectedSecondDailyId = prop($$props, 'selectedSecondDailyId', 3, null),
		// Override-able local state. `displayedMonth` is two-way bound by the
		// wrapper (and pushed imperatively via the wrapper's setDisplayedMonth),
		// so it is $bindable; its default references `today`, hence the ordering.
		today = prop($$props, 'today', 19, moment),
		displayedMonth = prop($$props, 'displayedMonth', 31, () => proxy(today()));

	const isMobile = obsidian.Platform.isMobile;

	// Year-overview popup open/close is local, transient UI state (not
	// persisted). The history button toggles it; a window click closes it.
	let yearOverviewOpen = state(false);

	function toggleYearOverview() {
		set(yearOverviewOpen, !get(yearOverviewOpen));
	}

	function incrementDisplayedYear() {
		displayedMonth(displayedMonth().clone().add(1, "year"));
	}

	function decrementDisplayedYear() {
		displayedMonth(displayedMonth().clone().subtract(1, "year"));
	}

	// Clicking a month in the popup navigates the day grid to it and closes.
	function selectMonth(date) {
		displayedMonth(date);
		set(yearOverviewOpen, false);
	}

	// getMonth/getDaysOfWeek read moment's global locale; `localeData` is passed
	// as a reactivity trigger so these re-derive when the locale / week-start
	// change. The parent now keys `localeData` on the locale settings (not
	// `today`), so these no longer rebuild on every content tick. See utils.ts.
	const month = user_derived(() => getMonth(displayedMonth(), $$props.localeData));

	const daysOfWeek = user_derived(() => getDaysOfWeek($$props.localeData));

	// Exports
	function incrementDisplayedMonth() {
		displayedMonth(displayedMonth().clone().add(1, "month"));
	}

	function decrementDisplayedMonth() {
		displayedMonth(displayedMonth().clone().subtract(1, "month"));
	}

	function resetDisplayedMonth() {
		displayedMonth(today().clone());
	}

	var $$exports = {
		incrementDisplayedMonth,
		decrementDisplayedMonth,
		resetDisplayedMonth
	};

	var div = root_5();

	event('click', $window, () => {
		if (get(yearOverviewOpen)) set(yearOverviewOpen, false);
	});

	let classes;
	var node = child(div);

	Nav(node, {
		get today() {
			return today();
		},

		get displayedMonth() {
			return displayedMonth();
		},
		incrementDisplayedMonth,
		decrementDisplayedMonth,
		get quarterVisible() {
			return $$props.quarterVisible;
		},

		get onClickMonth() {
			return $$props.onClickMonth;
		},

		get onClickYear() {
			return $$props.onClickYear;
		},

		get onClickQuarter() {
			return $$props.onClickQuarter;
		},

		get onClickToday() {
			return onClickToday();
		},

		get showTodayButtonOnMobile() {
			return showTodayButtonOnMobile();
		},

		get showYearOverviewButton() {
			return showYearOverview();
		},

		get yearOverviewOpen() {
			return get(yearOverviewOpen);
		},
		onToggleYearOverview: toggleYearOverview,
		resetDisplayedMonth
	});

	var node_1 = sibling(node, 2);

	{
		var consequent = ($$anchor) => {
			var div_1 = root$1();
			var node_2 = child(div_1);

			YearGrid(node_2, {
				get today() {
					return today();
				},

				get displayedMonth() {
					return displayedMonth();
				},

				get monthsWithNotes() {
					return monthsWithNotes();
				},
				onSelectMonth: selectMonth,
				incrementDisplayedYear,
				decrementDisplayedYear
			});
			delegated('click', div_1, (e) => e.stopPropagation());
			append($$anchor, div_1);
		};

		if_block(node_1, ($$render) => {
			if (get(yearOverviewOpen)) $$render(consequent);
		});
	}

	var table = sibling(node_1, 2);
	var colgroup = child(table);
	var node_3 = child(colgroup);

	{
		var consequent_1 = ($$anchor) => {
			var col = root_1();

			append($$anchor, col);
		};

		if_block(node_3, ($$render) => {
			if (showWeekNums() && !showWeekNumsRight()) $$render(consequent_1);
		});
	}

	var node_4 = sibling(node_3);

	each(node_4, 17, () => get(month)[1].days, index, ($$anchor, _date) => {
		var col_1 = root_1();

		append($$anchor, col_1);
	});

	var thead = sibling(colgroup);
	var tr = child(thead);
	var node_5 = child(tr);

	{
		var consequent_2 = ($$anchor) => {
			var th = root_2();

			append($$anchor, th);
		};

		if_block(node_5, ($$render) => {
			if (showWeekNums() && !showWeekNumsRight()) $$render(consequent_2);
		});
	}

	var node_6 = sibling(node_5);

	each(node_6, 17, () => get(daysOfWeek), index, ($$anchor, dayOfWeek, i) => {
		var th_1 = root_3();
		let classes_1;
		var text = child(th_1);

		template_effect(
			($0) => {
				classes_1 = set_class(th_1, 1, 'svelte-1cv5gx', null, classes_1, $0);
				set_text(text, get(dayOfWeek));
			},
			[
				() => ({ weekend: isWeekend(get(month)[1].days[i], weekendDays()) })
			]
		);

		append($$anchor, th_1);
	});

	var node_7 = sibling(node_6);

	{
		var consequent_3 = ($$anchor) => {
			var th_2 = root_2();

			append($$anchor, th_2);
		};

		if_block(node_7, ($$render) => {
			if (showWeekNums() && showWeekNumsRight()) $$render(consequent_3);
		});
	}

	var tbody = sibling(thead);

	each(tbody, 21, () => get(month), (week) => week.weekNum, ($$anchor, week) => {
		var tr_1 = root_4();
		var node_8 = child(tr_1);

		{
			var consequent_4 = ($$anchor) => {
				{
					let $0 = user_derived(() => getWeeklyMetadata(sources(), get(week).days[0], today()));
					let $1 = user_derived(() => !showWeekNumsRight());

					WeekNum($$anchor, spread_props(() => get(week), {
						get metadata() {
							return get($0);
						},

						get onClick() {
							return $$props.onClickWeek;
						},

						get onContextMenu() {
							return $$props.onContextMenuWeek;
						},

						get onHover() {
							return $$props.onHoverWeek;
						},

						get selectedId() {
							return $$props.selectedId;
						},

						get gridRight() {
							return get($1);
						}
					}));
				}
			};

			if_block(node_8, ($$render) => {
				if (showWeekNums() && !showWeekNumsRight()) $$render(consequent_4);
			});
		}

		var node_9 = sibling(node_8);

		each(node_9, 17, () => get(week).days, (day) => day.format(), ($$anchor, day) => {
			{
				let $0 = user_derived(() => getDailyMetadata(sources(), get(day), today()));

				Day($$anchor, {
					get date() {
						return get(day);
					},

					get today() {
						return today();
					},

					get displayedMonth() {
						return displayedMonth();
					},

					get weekendDays() {
						return weekendDays();
					},

					get onClick() {
						return $$props.onClickDay;
					},

					get onContextMenu() {
						return $$props.onContextMenuDay;
					},

					get onHover() {
						return $$props.onHoverDay;
					},

					get metadata() {
						return get($0);
					},

					get selectedId() {
						return $$props.selectedId;
					},

					get selectedSecondDailyId() {
						return selectedSecondDailyId();
					}
				});
			}
		});

		var node_10 = sibling(node_9);

		{
			var consequent_5 = ($$anchor) => {
				{
					let $0 = user_derived(() => getWeeklyMetadata(sources(), get(week).days[0], today()));
					let $1 = user_derived(() => !showWeekNumsRight());

					WeekNum($$anchor, spread_props(() => get(week), {
						get metadata() {
							return get($0);
						},

						get onClick() {
							return $$props.onClickWeek;
						},

						get onContextMenu() {
							return $$props.onContextMenuWeek;
						},

						get onHover() {
							return $$props.onHoverWeek;
						},

						get selectedId() {
							return $$props.selectedId;
						},

						get gridRight() {
							return get($1);
						}
					}));
				}
			};

			if_block(node_10, ($$render) => {
				if (showWeekNums() && showWeekNumsRight()) $$render(consequent_5);
			});
		}
		append($$anchor, tr_1);
	});
	template_effect(() => classes = set_class(div, 1, 'container svelte-1cv5gx', null, classes, { 'is-mobile': isMobile }));
	append($$anchor, div);

	return pop($$exports);
}

delegate(['click']);

/**
 * Mark, in `out`, every month index (0 = Jan … 11 = Dec) of `year` that has at
 * least one note in the given store. The store is keyed by `getDateUID`
 * output: `${unit}-${ISOdate}` (e.g. `day-2026-06-12T00:00:00-07:00`). The
 * unit ("day" / "week" / "month") contains no "-", so the first "-" separates
 * it from the ISO timestamp. We read the year/month digits directly off the
 * ISO string's local-date portion (`YYYY-MM-…`) rather than parsing it with
 * moment: the stored string already encodes the intended local date, so
 * reading the chars can't shift a month across a timezone boundary, and it
 * avoids a `moment.parseZone` call per stored UID (this runs across every
 * tracked note when the year overview is enabled).
 */
function fillMonthsForStore(notes, year, out) {
    if (!notes)
        return;
    for (const uid of Object.keys(notes)) {
        const iso = uid.substring(uid.indexOf("-") + 1);
        if (parseInt(iso.slice(0, 4), 10) === year) {
            out[parseInt(iso.slice(5, 7), 10) - 1] = true;
        }
    }
}
/**
 * Returns 12 booleans (Jan..Dec): true when that month has any daily, weekly,
 * or monthly note in `year`. Disabled periodicities pass empty stores, so they
 * contribute nothing. A weekly note is bucketed by its start-of-week date's
 * month (a coarse "this month has activity" signal for the year overview dot).
 */
function getMonthsWithNotes(year, daily, weekly, monthly) {
    const out = Array.from({ length: 12 }, () => false);
    fillMonthsForStore(daily, year, out);
    fillMonthsForStore(weekly, year, out);
    fillMonthsForStore(monthly, year, out);
    return out;
}

var root = from_html(`<div><!></div>`);

function Calendar($$anchor, $$props) {
	push($$props, true);

	const $settings = () => store_get(settings, '$settings', $$stores);
	const $dailyNotes = () => store_get(dailyNotes, '$dailyNotes', $$stores);
	const $weeklyNotes = () => store_get(weeklyNotes, '$weeklyNotes', $$stores);
	const $monthlyNotes = () => store_get(monthlyNotes, '$monthlyNotes', $$stores);
	const $activeFile = () => store_get(activeFile, '$activeFile', $$stores);
	const $activeSecondDailyFile = () => store_get(activeSecondDailyFile, '$activeSecondDailyFile', $$stores);
	const [$$stores, $$cleanup] = setup_stores();
	let today = state(proxy(moment()));

	// `displayedMonth` is local per-view UI state (which month the calendar
	// shows). It is two-way bound to CalendarBase (nav arrows / year popup
	// mutate it) and pushed imperatively from the view via setDisplayedMonth.
	// Initialized to the current month (moment(), same instant as `today`); it
	// then diverges as the user navigates, so it intentionally does NOT track
	// `today` reactively.
	let displayedMonth = state(proxy(moment()));

	// Settings → locale + store reindex. Side effects, so this lives in
	// $effect.pre (runs before the DOM updates, keeping the legacy `$:`
	// ordering: stores populated before children render).
	//
	// Reindexing a note store walks its folder and parses every filename, so it
	// is both *selective* (only stores whose folder/format/enabled changed) and
	// *debounced* on subsequent changes — a folder/format field saves on every
	// keystroke, and rescanning a populated folder per keystroke lagged on large
	// vaults. The locale config and the (cheap) `today` bump stay immediate so
	// dot-style / week-start / other display settings still respond instantly;
	// only the expensive folder rescan waits for a typing pause. The very first
	// run (mount) reindexes immediately so the calendar is populated on open.
	let reindexedSettings = null;

	let mounted = false;

	const debouncedReindex = obsidian.debounce(
		() => {
			const s = get$1(settings);

			if (reindexChangedStores(s, reindexedSettings)) {
				// Reflect the freshly-scanned stores in the cells (their metadata reads
				// the stores non-reactively, so a `today` bump is what re-derives them).
				set(today, moment(), true);
			}

			reindexedSettings = s;
		},
		300,
		true
	);

	user_pre_effect(() => {
		const s = $settings();

		configureGlobalMomentLocale(s.localeOverride, s.weekStart);
		set(today, moment(), true);

		if (!mounted) {
			mounted = true;
			reindexChangedStores(s, null);
			reindexedSettings = s;
		} else {
			debouncedReindex();
		}
	});

	// Cancel a pending rescan / tick if the view is torn down before they fire.
	user_effect(() => () => {
		debouncedReindex.cancel();
		coalescedTick.cancel();
	});

	// Stable empty reference used when the year overview is disabled (below), so
	// the derived doesn't churn identity while off.
	const EMPTY_MONTHS = Array.from({ length: 12 }, () => false);

	// Recomputed when the displayed year changes (via the year-overview arrows,
	// which mutate displayedMonth) or when any note store changes. Keyed on the
	// year (a primitive `$derived`) rather than `displayedMonth` directly, so
	// plain month navigation within the same year doesn't re-run the (store-wide)
	// getMonthsWithNotes scan — the derived's value equality skips it.
	//
	// Gated on `showYearOverview`: when the year popup is disabled (the majority
	// case), the note-store reads below are never evaluated, so they aren't
	// dependencies and this scan does NOT re-run on every file create/delete/
	// rename (store mutations bypass tick coalescing, so this was the one
	// uncoalesced per-mutation cost — notably during a sync burst / bulk import).
	const displayedYear = user_derived(() => get(displayedMonth).year());

	const monthsWithNotes = user_derived(() => $settings().showYearOverview
		? getMonthsWithNotes(get(displayedYear), $dailyNotes(), $weeklyNotes(), $monthlyNotes())
		: EMPTY_MONTHS);

	// Locale data for the calendar grid. getMonth/getDaysOfWeek read moment's
	// *global* locale directly and use this only as a reactivity trigger, so it
	// just needs a fresh identity when the locale actually changes. Key it on the
	// settings that drive the locale (applied by configureGlobalMomentLocale in
	// the $effect.pre above) via `moment()` — NOT `today` — so it stays stable
	// across content ticks and the 42-cell month grid stops rebuilding every tick.
	const localeData = user_derived(() => {
		void $settings().localeOverride;
		void $settings().weekStart;

		return Object.assign({}, moment().localeData());
	});

	// Imperative API exposed to the view (CalendarView) via mount()'s exports.
	//
	// A tick re-derives every visible cell's metadata (the sources read the note
	// stores non-reactively, so reassigning `today` is what re-runs them). File
	// events fan out into redundant ticks: editing the active daily note fires
	// both onFileModified and onMetadataCacheChanged, and a sync burst fires one
	// per modified file. Coalescing back-to-back calls into a single `today` bump
	// (next frame) collapses those duplicates — a tick is idempotent, so merging
	// them only removes wasted recompute; the refresh is delayed by at most the
	// debounce window, which is imperceptible. (The thumbnail ready-callback is
	// already debounced the same way.)
	const coalescedTick = obsidian.debounce(
		() => {
			set(today, moment(), true);
		},
		16
	);

	function tick() {
		coalescedTick();
	}

	// Jump the calendar to a given month — used by the "Reveal active note"
	// command. displayedMonth is per-view local state, so the view drives it
	// through this setter rather than a shared store (see FUTURE_PLANS.md).
	function setDisplayedMonth(date) {
		set(displayedMonth, date, true);
	}

	// A store only needs rescanning when the inputs that determine its contents
	// change: enabled, folder, or format. (Display-only settings like dotMode or
	// weekendDays don't affect which notes exist; file create/delete/rename are
	// handled incrementally by the vault listeners in view.ts.)
	function periodChanged(a, b) {
		return !b || a.enabled !== b.enabled || a.folder !== b.folder || a.format !== b.format;
	}

	// Returns true if any store was actually rescanned.
	function reindexChangedStores(s, prev) {
		let any = false;

		if (periodChanged(s.daily, prev === null || prev === void 0 ? void 0 : prev.daily)) {
			dailyNotes.reindex();
			any = true;
		}

		if (periodChanged(s.weekly, prev === null || prev === void 0 ? void 0 : prev.weekly)) {
			weeklyNotes.reindex();
			any = true;
		}

		if (periodChanged(s.monthly, prev === null || prev === void 0 ? void 0 : prev.monthly)) {
			monthlyNotes.reindex();
			any = true;
		}

		if (periodChanged(s.yearly, prev === null || prev === void 0 ? void 0 : prev.yearly)) {
			yearlyNotes.reindex();
			any = true;
		}

		if (periodChanged(s.quarterly, prev === null || prev === void 0 ? void 0 : prev.quarterly)) {
			quarterlyNotes.reindex();
			any = true;
		}

		if (periodChanged(s.secondDaily, prev === null || prev === void 0 ? void 0 : prev.secondDaily)) {
			secondDailyNotes.reindex();
			any = true;
		}

		return any;
	}

	// 1 minute heartbeat to keep `today` reflecting the current day. Only act
	// when the day actually rolls over — otherwise this would reassign `today`
	// every 60s and needlessly recompute every cell's metadata once a minute.
	user_effect(() => {
		const heartbeat = setInterval(
			() => {
				const now = moment();

				if (now.isSame(get(today), "day")) return;

				// Day rolled over (e.g. midnight). If we were viewing the (old) current
				// month, follow into the new month so "today" stays visible.
				const wasViewingCurrentMonth = get(displayedMonth).isSame(get(today), "month");

				set(today, now, true);

				if (wasViewingCurrentMonth) {
					set(displayedMonth, now, true);
				}
			},
			1000 * 60
		);

		return () => clearInterval(heartbeat);
	});

	var $$exports = { tick, setDisplayedMonth };
	var div = root();
	let classes;
	var node = child(div);

	Calendar$1(node, {
		get sources() {
			return $$props.sources;
		},

		get today() {
			return get(today);
		},

		get onHoverDay() {
			return $$props.onHoverDay;
		},

		get onHoverWeek() {
			return $$props.onHoverWeek;
		},

		get onContextMenuDay() {
			return $$props.onContextMenuDay;
		},

		get onContextMenuWeek() {
			return $$props.onContextMenuWeek;
		},

		get onClickDay() {
			return $$props.onClickDay;
		},

		get onClickWeek() {
			return $$props.onClickWeek;
		},

		get onClickMonth() {
			return $$props.onClickMonth;
		},

		get onClickYear() {
			return $$props.onClickYear;
		},

		get onClickQuarter() {
			return $$props.onClickQuarter;
		},

		get onClickToday() {
			return $$props.onClickToday;
		},

		get localeData() {
			return get(localeData);
		},

		get selectedId() {
			return $activeFile();
		},

		get selectedSecondDailyId() {
			return $activeSecondDailyFile();
		},

		get showWeekNums() {
			return $settings().weekly.enabled;
		},

		get showWeekNumsRight() {
			return $settings().showWeeklyNoteRight;
		},

		get quarterVisible() {
			return $settings().quarterly.enabled;
		},

		get weekendDays() {
			return $settings().weekendDays;
		},

		get showTodayButtonOnMobile() {
			return $settings().showTodayButtonOnMobile;
		},

		get showYearOverview() {
			return $settings().showYearOverview;
		},

		get monthsWithNotes() {
			return get(monthsWithNotes);
		},

		get displayedMonth() {
			return get(displayedMonth);
		},

		set displayedMonth($$value) {
			set(displayedMonth, $$value, true);
		}
	});

	template_effect(() => classes = set_class(div, 1, 'calendar-plus-wrapper', null, classes, {
		'daily-enabled': $settings().daily.enabled,
		'monthly-enabled': $settings().monthly.enabled,
		'quarterly-enabled': $settings().quarterly.enabled,
		'yearly-enabled': $settings().yearly.enabled,
		'weekend-shading-enabled': $settings().shadeWeekendColumns
	}));

	append($$anchor, div);

	var $$pop = pop($$exports);

	$$cleanup();

	return $$pop;
}

function showFileMenu(app, file, position, 
// Optional hook to add caller-specific items (e.g. the feature-image
// toggle) before the standard file-menu items.
addExtraItems) {
    const fileMenu = new obsidian.Menu();
    addExtraItems === null || addExtraItems === void 0 ? void 0 : addExtraItems(fileMenu);
    fileMenu.addItem((item) => item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => {
        app.fileManager.promptForFileDeletion(file);
    }));
    fileMenu.addItem((item) => item
        .setTitle("Open in new tab")
        .setIcon("file-plus")
        .setSection("open")
        .onClick(() => {
        void app.workspace.openLinkText(file.path, "", true);
    }));
    app.workspace.trigger("file-menu", fileMenu, file, "calendar-context-menu", null);
    fileMenu.showAtPosition(position);
}

const getStreakClasses = (file) => {
    return classList({
        "has-note": !!file,
    });
};
const getNoteExistsDots = (file) => {
    if (!file)
        return [];
    // The presence dot is only emitted in "exists" mode. In "word-count-tasks"
    // mode, the word-count source emits filled dots instead and the tasks
    // source emits the open-task hollow dot; this source still emits the
    // `has-note` class either way so themes can target it as a hook.
    const { dotMode } = get$1(settings);
    if (dotMode !== "exists")
        return [];
    return [{ isFilled: true }];
};
const streakSource = {
    getDailyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
        return {
            classes: getStreakClasses(file),
            dots: getNoteExistsDots(file),
        };
    },
    getWeeklyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
        return {
            classes: getStreakClasses(file),
            dots: getNoteExistsDots(file),
        };
    },
};

function getNoteTags(note) {
    var _a;
    if (!note) {
        return [];
    }
    const { metadataCache } = window.app;
    const frontmatter = (_a = metadataCache.getFileCache(note)) === null || _a === void 0 ? void 0 : _a.frontmatter;
    const tags = [];
    if (frontmatter) {
        const frontmatterTags = obsidian.parseFrontMatterTags(frontmatter) || [];
        tags.push(...frontmatterTags);
    }
    // strip the '#' at the beginning
    return tags.map((tag) => tag.substring(1));
}
function getFormattedTagAttributes(note) {
    const attrs = {};
    const tags = getNoteTags(note);
    const [emojiTags, nonEmojiTags] = partition(tags, (tag) => /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])/.test(tag));
    if (nonEmojiTags.length) {
        attrs["data-tags"] = nonEmojiTags.join(" ");
    }
    if (emojiTags.length) {
        attrs["data-emoji-tag"] = emojiTags[0];
    }
    return attrs;
}
const customTagsSource = {
    getDailyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
        return {
            dataAttributes: getFormattedTagAttributes(file),
            dots: [],
        };
    },
    getWeeklyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
        return {
            dataAttributes: getFormattedTagAttributes(file),
            dots: [],
        };
    },
};

// Match open-task lines: `- [ ]` and `* [ ]`. Completed tasks (`- [x]`,
// `- [X]`) are intentionally excluded.
//
// Open-task regex ported from the original Calendar plugin
// (https://github.com/liamcain/obsidian-calendar-plugin), MIT.
const OPEN_TASK_RE = /(-|\*) \[ \]/g;
const cache = new Map();
async function compute(note) {
    var _a;
    const contents = await window.app.vault.cachedRead(note);
    return {
        wordCount: getWordCount(contents),
        openTasks: ((_a = contents.match(OPEN_TASK_RE)) !== null && _a !== void 0 ? _a : []).length,
    };
}
function getContentMetrics(note) {
    const cached = cache.get(note.path);
    if (cached && cached.mtime === note.stat.mtime) {
        return cached.metrics;
    }
    const metrics = compute(note);
    cache.set(note.path, { mtime: note.stat.mtime, metrics });
    // Don't let a transient read failure stick in the cache — drop the entry so
    // a later tick retries (only if it's still the entry we stored).
    void metrics.catch(() => {
        var _a;
        if (((_a = cache.get(note.path)) === null || _a === void 0 ? void 0 : _a.metrics) === metrics)
            cache.delete(note.path);
    });
    return metrics;
}

/**
 * Count the number of unchecked task lines in a note. Self-gated on
 * `dotMode === "word-count-tasks"` so the source has zero cost in the
 * default "exists" mode.
 */
async function getNumberOfRemainingTasks(note) {
    const { dotMode } = get$1(settings);
    if (dotMode !== "word-count-tasks" || !note) {
        return 0;
    }
    const { openTasks } = await getContentMetrics(note);
    return openTasks;
}
async function getDots$1(file) {
    if (!file)
        return [];
    const numTasks = await getNumberOfRemainingTasks(file);
    // One hollow task dot when any open tasks exist — a presence indicator,
    // not a count.
    return numTasks > 0
        ? [{ className: "task", isFilled: false }]
        : [];
}
const tasksSource = {
    getDailyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
        return { dots: await getDots$1(file) };
    },
    getWeeklyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
        return { dots: await getDots$1(file) };
    },
};

// Hard cap on how many word-count dots a single cell shows, matching the
// historical behavior the "Word count and open tasks" mode is restoring.
const NUM_MAX_DOTS = 5;
const DEFAULT_WORDS_PER_DOT = 250;
/**
 * Compute how many filled word-count dots a daily/weekly note earns.
 *
 * Self-gated: returns 0 when the user's dot style isn't "word-count-tasks",
 * so this source has zero cost in the default "exists" mode.
 *
 * Word-count and clamp logic ported from the original Calendar plugin
 * (https://github.com/liamcain/obsidian-calendar-plugin), MIT.
 */
async function getWordLengthAsDots(note) {
    const { dotMode, wordsPerDot } = get$1(settings);
    if (dotMode !== "word-count-tasks" || !note) {
        return 0;
    }
    const perDot = wordsPerDot !== null && wordsPerDot !== void 0 ? wordsPerDot : DEFAULT_WORDS_PER_DOT;
    if (perDot <= 0) {
        return 0;
    }
    const { wordCount } = await getContentMetrics(note);
    const numDots = wordCount / perDot;
    return clamp(Math.floor(numDots), 1, NUM_MAX_DOTS);
}
async function getDots(file) {
    if (!file)
        return [];
    const numSolidDots = await getWordLengthAsDots(file);
    const dots = [];
    for (let i = 0; i < numSolidDots; i++) {
        dots.push({ isFilled: true });
    }
    return dots;
}
const wordCountSource = {
    getDailyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
        return { dots: await getDots(file) };
    },
    getWeeklyMetadata: async (date) => {
        var _a;
        const file = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
        return { dots: await getDots(file) };
    },
};

const secondDailyNoteSource = {
    getDailyMetadata: async (date) => {
        var _a;
        if (!get$1(settings).secondDaily.enabled)
            return { dots: [] };
        const file = getPeriodicNote(date, "daily", (_a = get$1(secondDailyNotes)) !== null && _a !== void 0 ? _a : {});
        return { dots: file ? [{ isFilled: true, className: "second-daily" }] : [] };
    },
    getWeeklyMetadata: async () => ({ dots: [] }),
};

/**
 * Returns an ICalendarSource that populates `backgroundImage` on day/week
 * cells when the corresponding note has a qualifying image in its frontmatter
 * or embeds.
 *
 * Needs `app` for vault/metadataCache access, so it is created as a factory
 * rather than a plain module-level constant.
 *
 * Self-gated: returns empty metadata when `featureImage.enabled` is false,
 * so it has zero cost when the feature is off.
 */
// The image files currently used as a feature image by any daily/weekly note
// (skipping notes whose image is hidden). Used to garbage-collect thumbnails
// for images no longer referenced (e.g. a swapped-out banner) even though the
// file still exists in the vault.
function collectInUseFeatureImages(app) {
    var _a, _b;
    const s = get$1(settings);
    if (!s.featureImage.enabled)
        return [];
    const props = s.featureImage.frontmatterProperties;
    const hidden = s.featureImage.hiddenNotes;
    const out = [];
    const seen = new Set();
    const consider = (note) => {
        if (hidden.includes(note.path))
            return;
        const img = resolveFeatureImageFile(note, app, props);
        if (!img)
            return;
        const id = `${img.path} ${img.stat.mtime}`;
        if (!seen.has(id)) {
            seen.add(id);
            out.push(img);
        }
    };
    if (s.daily.enabled) {
        for (const note of Object.values((_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {}))
            consider(note);
    }
    if (s.weekly.enabled && s.featureImage.showForWeekly) {
        for (const note of Object.values((_b = get$1(weeklyNotes)) !== null && _b !== void 0 ? _b : {}))
            consider(note);
    }
    return out;
}
let sweptThisSession = false;
/**
 * Prune thumbnails for images that are no longer any note's feature image.
 * Runs at most once per session (it scans all periodic notes, so the view
 * calls it deferred, off the open/render path). No-op when feature images are
 * disabled, so disabling the feature doesn't wipe the cache.
 */
function sweepUnusedThumbnailsOnce(app) {
    if (sweptThisSession)
        return;
    if (!get$1(settings).featureImage.enabled)
        return;
    sweptThisSession = true;
    void pruneThumbnailsExcept(collectInUseFeatureImages(app));
}
function createFeatureImageSource(app) {
    // Resolve a note to the URL we should paint as its cell background: a small
    // cached thumbnail when available, the full-resolution image when there's no
    // cache, or null while a thumbnail is still being generated (the cell shows
    // nothing for that render; a ready callback re-renders it when the thumbnail
    // lands).
    const backgroundFor = (note, props) => {
        const imageFile = resolveFeatureImageFile(note, app, props);
        if (!imageFile)
            return null;
        if (!isThumbnailCacheAvailable()) {
            return app.vault.getResourcePath(imageFile);
        }
        return getThumbnailUrl(imageFile);
    };
    return {
        getDailyMetadata: async (date) => {
            var _a;
            const s = get$1(settings);
            if (!s.featureImage.enabled || !s.daily.enabled)
                return {};
            const file = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!file)
                return {};
            // Per-note opt-out (toggled from the day-cell menu, stored in settings).
            if (s.featureImage.hiddenNotes.includes(file.path))
                return {};
            const url = backgroundFor(file, s.featureImage.frontmatterProperties);
            return url ? { backgroundImage: url } : {};
        },
        getWeeklyMetadata: async (date) => {
            var _a;
            const s = get$1(settings);
            if (!s.featureImage.enabled || !s.featureImage.showForWeekly || !s.weekly.enabled) {
                return {};
            }
            const file = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!file)
                return {};
            if (s.featureImage.hiddenNotes.includes(file.path))
                return {};
            const url = backgroundFor(file, s.featureImage.frontmatterProperties);
            return url ? { backgroundImage: url } : {};
        },
    };
}

class CalendarView extends obsidian.ItemView {
    // The plugin ref is used to persist settings the view itself can change
    // (currently the per-note feature-image hidden list) via writeOptions.
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.calendar = null;
        this.unregisterThumbnailReady = null;
        // Guards against a rapid double Alt-click creating the same second daily note
        // twice (createPeriodicNote is called directly here, bypassing the shared
        // in-flight guard in periodicNotes.ts). Keyed by the target filename.
        this.secondDailyCreateInFlight = new Set();
        this.onHoverDay = (date, targetEl, isMetaPressed) => {
            var _a;
            if (!isMetaPressed || !this.settings.daily.enabled) {
                return;
            }
            const format = this.settings.daily.format;
            const note = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
            this.app.workspace.trigger("link-hover", this, targetEl, date.format(format), note === null || note === void 0 ? void 0 : note.path);
        };
        this.onHoverWeek = (date, targetEl, isMetaPressed) => {
            var _a;
            if (!isMetaPressed || !this.settings.weekly.enabled) {
                return;
            }
            const format = this.settings.weekly.format;
            const note = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
            this.app.workspace.trigger("link-hover", this, targetEl, date.format(format), note === null || note === void 0 ? void 0 : note.path);
        };
        this.onHoverMonth = (date, targetEl, isMetaPressed) => {
            var _a;
            if (!isMetaPressed || !this.settings.monthly.enabled) {
                return;
            }
            const format = this.settings.monthly.format;
            const note = getPeriodicNote(date, "monthly", (_a = get$1(monthlyNotes)) !== null && _a !== void 0 ? _a : {});
            this.app.workspace.trigger("link-hover", this, targetEl, date.format(format), note === null || note === void 0 ? void 0 : note.path);
        };
        this.onHoverYear = (date, targetEl, isMetaPressed) => {
            var _a;
            if (!isMetaPressed || !this.settings.yearly.enabled) {
                return;
            }
            const format = this.settings.yearly.format;
            const note = getPeriodicNote(date, "yearly", (_a = get$1(yearlyNotes)) !== null && _a !== void 0 ? _a : {});
            this.app.workspace.trigger("link-hover", this, targetEl, date.format(format), note === null || note === void 0 ? void 0 : note.path);
        };
        this.onHoverQuarter = (date, targetEl, isMetaPressed) => {
            var _a;
            if (!isMetaPressed || !this.settings.quarterly.enabled) {
                return;
            }
            const format = this.settings.quarterly.format;
            const note = getPeriodicNote(date, "quarterly", (_a = get$1(quarterlyNotes)) !== null && _a !== void 0 ? _a : {});
            this.app.workspace.trigger("link-hover", this, targetEl, date.format(format), note === null || note === void 0 ? void 0 : note.path);
        };
        this.onContextMenuDay = (date, event) => {
            var _a, _b, _c;
            const { secondDaily, daily } = this.settings;
            const position = { x: event.pageX, y: event.pageY };
            if (secondDaily.enabled) {
                const menu = new obsidian.Menu();
                const primaryNote = daily.enabled
                    ? getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {})
                    : null;
                const secondNote = getPeriodicNote(date, "daily", (_b = get$1(secondDailyNotes)) !== null && _b !== void 0 ? _b : {});
                // Daily note actions. When the note exists, offer Open + Delete in their
                // own section at the top — mirroring the second daily note's Open/Delete
                // items. When it doesn't, the single "Create Daily Note" stays grouped
                // with the second daily create item below (no divider, same section).
                if (daily.enabled && primaryNote) {
                    menu.addItem((item) => item
                        .setTitle("Open daily note")
                        .setIcon("calendar-days")
                        .setSection("calendar-daily")
                        .onClick(() => void this.openOrCreateDailyNote(date, false)));
                    menu.addItem((item) => item
                        .setTitle("Delete daily note")
                        .setIcon("trash")
                        .setSection("calendar-daily")
                        .onClick(() => void this.app.fileManager.trashFile(primaryNote)));
                    this.addFeatureImageMenuItem(menu, primaryNote);
                }
                else if (daily.enabled && !primaryNote) {
                    menu.addItem((item) => item
                        .setTitle("Create daily note")
                        .setIcon("calendar-plus")
                        // calendar-daily (not calendar-actions) so the primary-note item
                        // is always its own section, giving a consistent divider above the
                        // second-daily items whether or not the primary note exists.
                        .setSection("calendar-daily")
                        .onClick(() => void this.openOrCreateDailyNote(date, false)));
                }
                menu.addItem((item) => item
                    .setTitle(secondNote ? "Open second daily note" : "Create second daily note")
                    .setIcon("notebook")
                    .setSection("calendar-actions")
                    .onClick(() => void this.openOrCreateSecondDailyNote(date, false)));
                if (secondNote) {
                    menu.addItem((item) => item
                        .setTitle("Delete second daily note")
                        .setIcon("trash")
                        .setSection("calendar-actions")
                        .onClick(() => void this.app.fileManager.trashFile(secondNote)));
                }
                // If the primary note exists, append its standard file-menu items below.
                if (primaryNote) {
                    this.app.workspace.trigger("file-menu", menu, primaryNote, "calendar-context-menu", null);
                }
                menu.showAtPosition(position);
                return;
            }
            // Fallback: existing behavior when second daily is not enabled.
            if (!daily.enabled)
                return;
            const note = getPeriodicNote(date, "daily", (_c = get$1(dailyNotes)) !== null && _c !== void 0 ? _c : {});
            if (!note)
                return;
            showFileMenu(this.app, note, position, (menu) => this.addFeatureImageMenuItem(menu, note));
        };
        this.openOrCreateSecondDailyNote = async (date, ctrlPressed) => {
            var _a;
            if (!this.settings.secondDaily.enabled)
                return;
            const { workspace } = this.app;
            const existingFile = getPeriodicNote(date, "daily", (_a = get$1(secondDailyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                const secondDailySettings = this.settings.secondDaily;
                const filename = date.format(secondDailySettings.format);
                const create = async () => {
                    if (this.secondDailyCreateInFlight.has(filename))
                        return;
                    this.secondDailyCreateInFlight.add(filename);
                    try {
                        const file = await createPeriodicNote("daily", date, secondDailySettings);
                        const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
                        await leaf.openFile(file, { active: true });
                        // Synchronous highlight update, matching the primary daily/weekly
                        // paths — drives the grey second-daily highlight without waiting on
                        // file-open event timing (unreliable on mobile).
                        activeFile.setFile(file);
                        activeSecondDailyFile.setFile(file);
                    }
                    finally {
                        this.secondDailyCreateInFlight.delete(filename);
                    }
                };
                if (this.settings.shouldConfirmBeforeCreate) {
                    createConfirmationDialog({
                        cta: "Create",
                        onAccept: create,
                        text: `File ${filename} does not exist. Would you like to create it?`,
                        title: "New Second Daily Note",
                    });
                }
                else {
                    await create();
                }
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            activeFile.setFile(existingFile);
            activeSecondDailyFile.setFile(existingFile);
        };
        this.onContextMenuWeek = (date, event) => {
            var _a;
            if (!this.settings.weekly.enabled)
                return;
            const note = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!note) {
                return;
            }
            showFileMenu(this.app, note, {
                x: event.pageX,
                y: event.pageY,
            });
        };
        this.onContextMenuMonth = (date, event) => {
            var _a;
            if (!this.settings.monthly.enabled)
                return;
            const note = getPeriodicNote(date, "monthly", (_a = get$1(monthlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!note) {
                return;
            }
            showFileMenu(this.app, note, {
                x: event.pageX,
                y: event.pageY,
            });
        };
        this.onContextMenuYear = (date, event) => {
            var _a;
            if (!this.settings.yearly.enabled)
                return;
            const note = getPeriodicNote(date, "yearly", (_a = get$1(yearlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!note) {
                return;
            }
            showFileMenu(this.app, note, {
                x: event.pageX,
                y: event.pageY,
            });
        };
        this.onContextMenuQuarter = (date, event) => {
            var _a;
            if (!this.settings.quarterly.enabled)
                return;
            const note = getPeriodicNote(date, "quarterly", (_a = get$1(quarterlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!note) {
                return;
            }
            showFileMenu(this.app, note, {
                x: event.pageX,
                y: event.pageY,
            });
        };
        this.onFileDeleted = async (file) => {
            var _a, _b;
            if (!(file instanceof obsidian.TFile))
                return;
            // If a featured-image source was deleted, drop its cached thumbnail so it
            // doesn't orphan, invalidate any note resolutions pointing at it, and tick
            // so those cells re-resolve (they'd otherwise keep the now-dead image).
            if (isImagePath(file.path)) {
                void removeThumbnailsForSource(file.path);
                if (this.settings.featureImage.enabled) {
                    invalidateFeatureImageCacheForImage(file.path);
                    (_a = this.calendar) === null || _a === void 0 ? void 0 : _a.tick();
                }
            }
            const changed = [
                dailyNotes.removeFile(file),
                weeklyNotes.removeFile(file),
                monthlyNotes.removeFile(file),
                quarterlyNotes.removeFile(file),
                yearlyNotes.removeFile(file),
                secondDailyNotes.removeFile(file),
            ].some(Boolean);
            if (changed) {
                this.updateActiveFile();
                // A tracked note was removed — recompute so its dot/image clears.
                (_b = this.calendar) === null || _b === void 0 ? void 0 : _b.tick();
            }
        };
        this.onFileModified = async (file) => {
            if (!(file instanceof obsidian.TFile))
                return;
            const date = (this.settings.daily.enabled ? getDateFromFile(file, "daily", this.settings.daily.format) : null) ||
                (this.settings.weekly.enabled ? getDateFromFile(file, "weekly", this.settings.weekly.format) : null) ||
                (this.settings.monthly.enabled ? getDateFromFile(file, "monthly", this.settings.monthly.format) : null) ||
                (this.settings.quarterly.enabled ? getDateFromFile(file, "quarterly", this.settings.quarterly.format) : null) ||
                (this.settings.yearly.enabled ? getDateFromFile(file, "yearly", this.settings.yearly.format) : null);
            if (date && this.calendar) {
                this.calendar.tick();
            }
        };
        this.onFileCreated = (file) => {
            if (!this.app.workspace.layoutReady || !this.calendar)
                return;
            if (!(file instanceof obsidian.TFile))
                return;
            const changed = [
                dailyNotes.addFile(file),
                weeklyNotes.addFile(file),
                monthlyNotes.addFile(file),
                quarterlyNotes.addFile(file),
                yearlyNotes.addFile(file),
                secondDailyNotes.addFile(file),
            ].some(Boolean);
            if (changed) {
                this.calendar.tick();
            }
        };
        this.onFileRenamed = (file, oldPath) => {
            var _a, _b;
            if (!this.app.workspace.layoutReady || !this.calendar)
                return;
            if (!(file instanceof obsidian.TFile))
                return;
            // A renamed image's thumbnail is keyed on the old path; drop it (the new
            // path regenerates on demand) so it doesn't orphan. Also invalidate any
            // note resolutions that pointed at the old path and tick, so cells whose
            // links didn't auto-update re-resolve instead of keeping the dead image.
            if (isImagePath(oldPath)) {
                void removeThumbnailsForSource(oldPath);
                if (this.settings.featureImage.enabled) {
                    invalidateFeatureImageCacheForImage(oldPath);
                    (_a = this.calendar) === null || _a === void 0 ? void 0 : _a.tick();
                }
            }
            // If a note with a hidden featured image was renamed/moved, migrate its
            // stored path so it stays hidden (hiddenNotes holds vault paths).
            this.migrateHiddenNotePath(oldPath, file.path);
            // Remove the entry the old path mapped to, then add the new file. Each
            // call is a no-op if the file doesn't match that periodicity — same
            // gating logic as create/delete, just doubled up for the move.
            const removed = [
                dailyNotes.removeByOldPath(oldPath, file),
                weeklyNotes.removeByOldPath(oldPath, file),
                monthlyNotes.removeByOldPath(oldPath, file),
                quarterlyNotes.removeByOldPath(oldPath, file),
                yearlyNotes.removeByOldPath(oldPath, file),
                secondDailyNotes.removeByOldPath(oldPath, file),
            ].some(Boolean);
            const added = [
                dailyNotes.addFile(file),
                weeklyNotes.addFile(file),
                monthlyNotes.addFile(file),
                quarterlyNotes.addFile(file),
                yearlyNotes.addFile(file),
                secondDailyNotes.addFile(file),
            ].some(Boolean);
            if (removed || added) {
                this.updateActiveFile();
                // A tracked note moved in/out of a configured folder — recompute dots.
                (_b = this.calendar) === null || _b === void 0 ? void 0 : _b.tick();
            }
        };
        this.onMetadataCacheChanged = (file) => {
            if (!this.app.workspace.layoutReady || !this.calendar)
                return;
            if (!this.settings.featureImage.enabled)
                return;
            // Re-tick when a daily or weekly note's metadata changes (e.g. the user
            // edits the `banner` frontmatter property). vault.modify fires before the
            // cache updates, so this handler is the reliable post-update trigger for
            // frontmatter-driven featured images.
            const isDaily = this.settings.daily.enabled &&
                getDateFromFile(file, "daily", this.settings.daily.format);
            const isWeekly = this.settings.weekly.enabled &&
                this.settings.featureImage.showForWeekly &&
                getDateFromFile(file, "weekly", this.settings.weekly.format);
            if (isDaily || isWeekly) {
                // The metadata cache is now authoritative for this note; drop any memo
                // entry (possibly stale, stored during the earlier vault.modify before
                // the cache reparsed) so the tick re-resolves the image fresh.
                invalidateFeatureImageCache(file.path);
                this.calendar.tick();
            }
        };
        this.onFileOpen = (_file) => {
            if (this.app.workspace.layoutReady) {
                this.updateActiveFile();
            }
        };
        // Today button: jump to the current month (handled by the Calendar
        // component) and, if daily notes are enabled, open or create today's
        // daily note via the same path day-cell clicks use. Plain pane —
        // modifier state isn't passed from the Today control.
        this.onClickToday = (date) => {
            void this.openOrCreateDailyNote(date, false);
        };
        this.openOrCreateWeeklyNote = async (date, ctrlPressed) => {
            var _a;
            if (!this.settings.weekly.enabled)
                return;
            const { workspace } = this.app;
            const existingFile = getPeriodicNote(date, "weekly", (_a = get$1(weeklyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                void tryToCreateWeeklyNote(date.clone().startOf("week"), ctrlPressed, this.settings, (file) => {
                    activeFile.setFile(file);
                });
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            // Synchronously update the active-file store so the highlight lands
            // immediately, instead of waiting on workspace.on("file-open") — that
            // event's mobile timing isn't reliable enough to drive the highlight.
            // Matches the original Calendar plugin's pattern and the monthly /
            // quarterly / yearly existing-file paths below.
            activeFile.setFile(existingFile);
        };
        this.openOrCreateDailyNote = async (date, ctrlPressed, altPressed = false) => {
            var _a;
            const { workspace } = this.app;
            // Option/Alt + click is dedicated to the second daily note: open it if one
            // exists, otherwise prompt to create it (same open-or-create-with-confirm
            // flow as the right-click "Create Second Daily Note"). Falls through to the
            // normal primary-note flow when second daily is disabled, so Alt is a no-op
            // in that case.
            if (altPressed && this.settings.secondDaily.enabled) {
                await this.openOrCreateSecondDailyNote(date, ctrlPressed);
                return;
            }
            if (!this.settings.daily.enabled)
                return;
            const existingFile = getPeriodicNote(date, "daily", (_a = get$1(dailyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                void tryToCreateDailyNote(date, ctrlPressed, this.settings, (dailyNote) => {
                    activeFile.setFile(dailyNote);
                });
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            // Synchronous active-file update — see note in openOrCreateWeeklyNote.
            activeFile.setFile(existingFile);
        };
        this.openOrCreateMonthlyNote = async (date, ctrlPressed) => {
            var _a;
            if (!this.settings.monthly.enabled)
                return;
            const { workspace } = this.app;
            const startOfMonth = date.clone().startOf("month");
            const existingFile = getPeriodicNote(date, "monthly", (_a = get$1(monthlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                void tryToCreateMonthlyNote(startOfMonth, ctrlPressed, this.settings, (file) => {
                    activeFile.setFile(file);
                });
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            activeFile.setFile(existingFile);
            workspace.setActiveLeaf(leaf, { focus: true });
        };
        this.openOrCreateQuarterlyNote = async (date, ctrlPressed) => {
            var _a;
            if (!this.settings.quarterly.enabled)
                return;
            const { workspace } = this.app;
            const startOfQuarter = date.clone().startOf("quarter");
            const existingFile = getPeriodicNote(date, "quarterly", (_a = get$1(quarterlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                void tryToCreateQuarterlyNote(startOfQuarter, ctrlPressed, this.settings, (file) => {
                    activeFile.setFile(file);
                });
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            activeFile.setFile(existingFile);
            workspace.setActiveLeaf(leaf, { focus: true });
        };
        this.openOrCreateYearlyNote = async (date, ctrlPressed) => {
            var _a;
            if (!this.settings.yearly.enabled)
                return;
            const { workspace } = this.app;
            const startOfYear = date.clone().startOf("year");
            const existingFile = getPeriodicNote(date, "yearly", (_a = get$1(yearlyNotes)) !== null && _a !== void 0 ? _a : {});
            if (!existingFile) {
                void tryToCreateYearlyNote(startOfYear, ctrlPressed, this.settings, (file) => {
                    activeFile.setFile(file);
                });
                return;
            }
            const leaf = getLeafForModifierClick(ctrlPressed, this.settings, workspace);
            await leaf.openFile(existingFile);
            activeFile.setFile(existingFile);
            workspace.setActiveLeaf(leaf, { focus: true });
        };
        this.registerEvent(this.app.vault.on("create", this.onFileCreated));
        this.registerEvent(this.app.vault.on("delete", this.onFileDeleted));
        this.registerEvent(this.app.vault.on("modify", this.onFileModified));
        this.registerEvent(this.app.vault.on("rename", this.onFileRenamed));
        this.registerEvent(this.app.workspace.on("file-open", this.onFileOpen));
        this.registerEvent(this.app.metadataCache.on("changed", this.onMetadataCacheChanged));
        // settings.subscribe fires synchronously on registration, so this.settings
        // is assigned immediately (the `!` declaration above reflects that).
        this.register(settings.subscribe((val) => {
            this.settings = val;
            // No calendar.tick() here: the Calendar wrapper subscribes to the
            // settings store itself (an $effect.pre that reconfigures locale,
            // reindexes changed stores, and bumps `today`), so it already
            // refreshes on settings change. Calling tick() here too just doubled
            // the per-change recompute.
        }));
    }
    getViewType() {
        return VIEW_TYPE_CALENDAR;
    }
    getDisplayText() {
        return "Calendar Plus";
    }
    getIcon() {
        return "calendar-plus";
    }
    onClose() {
        var _a;
        (_a = this.unregisterThumbnailReady) === null || _a === void 0 ? void 0 : _a.call(this);
        this.unregisterThumbnailReady = null;
        if (this.calendar) {
            void unmount(this.calendar);
            this.calendar = null;
        }
        return Promise.resolve();
    }
    async onOpen() {
        // Integration point: external plugins can listen for `calendar-plus:open`
        // (TRIGGER_ON_OPEN) to feed in additional sources. wordCountSource and
        // tasksSource self-gate on `dotMode === "word-count-tasks"`, so they have
        // zero cost in the default "exists" mode.
        const sources = [
            customTagsSource,
            streakSource,
            wordCountSource,
            tasksSource,
            secondDailyNoteSource,
            createFeatureImageSource(this.app),
        ];
        this.app.workspace.trigger(TRIGGER_ON_OPEN, sources);
        this.calendar = mount(Calendar, {
            target: this.contentEl,
            props: {
                onClickDay: this.openOrCreateDailyNote,
                onClickWeek: this.openOrCreateWeeklyNote,
                onClickMonth: this.openOrCreateMonthlyNote,
                onClickYear: this.openOrCreateYearlyNote,
                onClickQuarter: this.openOrCreateQuarterlyNote,
                onClickToday: this.onClickToday,
                onHoverDay: this.onHoverDay,
                onHoverWeek: this.onHoverWeek,
                onContextMenuDay: this.onContextMenuDay,
                onContextMenuWeek: this.onContextMenuWeek,
                sources,
            },
        });
        // Initial active-file sync: file-open only catches transitions after
        // the constructor's listener attaches. If a daily/weekly note was
        // already open when this view mounts (e.g. user opens a note, then
        // reveals the calendar sidebar — common on mobile), without this the
        // active highlight stays missing until the user switches files.
        if (this.app.workspace.layoutReady) {
            this.updateActiveFile();
        }
        // When a feature-image thumbnail finishes generating in the background,
        // re-tick so its cell re-resolves and the image appears. Registered per
        // view and unregistered in onClose so multiple views each refresh and a
        // closed view's callback doesn't linger.
        this.unregisterThumbnailReady = registerThumbnailReadyCallback(() => { var _a; return (_a = this.calendar) === null || _a === void 0 ? void 0 : _a.tick(); });
        // Garbage-collect thumbnails for images no longer used as a featured image.
        // Deferred + once per session: it scans all periodic notes, so keep it off
        // the open/render path.
        window.setTimeout(() => sweepUnusedThumbnailsOnce(this.app), 3000);
    }
    // Adds a "Hide/Show featured image" toggle to a day-cell context menu when
    // featured images are enabled and the note has (or has hidden) one. The
    // hidden state lives in plugin data (settings.featureImage.hiddenNotes), so
    // toggling it persists via writeOptions and the cell refreshes through the
    // settings store — no note edit, no metadata-cache dependency.
    addFeatureImageMenuItem(menu, note) {
        const { featureImage } = this.settings;
        if (!featureImage.enabled)
            return;
        if (featureImage.hiddenNotes.includes(note.path)) {
            menu.addItem((item) => item
                .setTitle("Show featured image")
                .setIcon("image")
                .setSection("calendar-daily")
                .onClick(() => void this.setFeatureImageHidden(note, false)));
        }
        else if (resolveFeatureImageFile(note, this.app, featureImage.frontmatterProperties)) {
            menu.addItem((item) => item
                .setTitle("Hide featured image")
                .setIcon("image-off")
                .setSection("calendar-daily")
                .onClick(() => void this.setFeatureImageHidden(note, true)));
        }
    }
    // Toggle the per-note opt-out in plugin data (not frontmatter, so it adds
    // no Properties box to the note). Persisting via writeOptions updates the
    // settings store, which the calendar wrapper reacts to — so the cell
    // refreshes without touching the file or relying on metadata-cache events.
    async setFeatureImageHidden(note, hidden) {
        await this.plugin.writeOptions((prev) => {
            const current = prev.featureImage.hiddenNotes;
            const hiddenNotes = hidden
                ? current.includes(note.path)
                    ? current
                    : [...current, note.path]
                : current.filter((path) => path !== note.path);
            return { featureImage: Object.assign(Object.assign({}, prev.featureImage), { hiddenNotes }) };
        });
    }
    // Migrate a hidden note's stored path on rename/move so its featured image
    // stays hidden (hiddenNotes stores vault paths, which otherwise go stale).
    // No-op unless the old path was actually in the list.
    migrateHiddenNotePath(oldPath, newPath) {
        if (!this.settings.featureImage.hiddenNotes.includes(oldPath))
            return;
        void this.plugin.writeOptions((prev) => ({
            featureImage: Object.assign(Object.assign({}, prev.featureImage), { hiddenNotes: prev.featureImage.hiddenNotes.map((path) => path === oldPath ? newPath : path) }),
        }));
    }
    // Update the active-file highlight stores. Deliberately does NOT tick the
    // calendar: the highlight is driven reactively by these stores
    // (`selectedId` / `selectedSecondDailyId`), so switching notes only
    // re-renders the affected cells' highlight — no full metadata recompute.
    // Callers that also change cell *content* (file delete/rename) tick
    // explicitly afterward.
    updateActiveFile() {
        const file = this.app.workspace.getActiveFile();
        activeFile.setFile(file);
        activeSecondDailyFile.setFile(file);
    }
    revealActiveNote() {
        var _a, _b, _c, _d, _e;
        const file = this.app.workspace.getActiveFile();
        if (!file)
            return;
        let date = this.settings.daily.enabled
            ? getDateFromFile(file, "daily", this.settings.daily.format)
            : null;
        if (date) {
            (_a = this.calendar) === null || _a === void 0 ? void 0 : _a.setDisplayedMonth(date);
            return;
        }
        date = this.settings.weekly.enabled
            ? getDateFromFile(file, "weekly", this.settings.weekly.format)
            : null;
        if (date) {
            (_b = this.calendar) === null || _b === void 0 ? void 0 : _b.setDisplayedMonth(date);
            return;
        }
        date = this.settings.monthly.enabled
            ? getDateFromFile(file, "monthly", this.settings.monthly.format)
            : null;
        if (date) {
            (_c = this.calendar) === null || _c === void 0 ? void 0 : _c.setDisplayedMonth(date);
            return;
        }
        date = this.settings.quarterly.enabled
            ? getDateFromFile(file, "quarterly", this.settings.quarterly.format)
            : null;
        if (date) {
            (_d = this.calendar) === null || _d === void 0 ? void 0 : _d.setDisplayedMonth(date);
            return;
        }
        date = this.settings.yearly.enabled
            ? getDateFromFile(file, "yearly", this.settings.yearly.format)
            : null;
        if (date) {
            (_e = this.calendar) === null || _e === void 0 ? void 0 : _e.setDisplayedMonth(date);
            return;
        }
    }
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Recursively merge `patch` onto `base`, returning a new object. Plain-object
 * values merge key-by-key at any depth; everything else (primitives, arrays) is
 * replaced wholesale by the patch value, and a patch value of `undefined` is
 * ignored (keeps base).
 *
 * This is the single mechanism behind both default-backfill on load and nested
 * settings writes, replacing a hand-maintained per-key merge. It matters
 * because Calendar Plus has "no migration code" as a product rule, so
 * default-backfill-on-load is the *entire* forward-compat path: a saved blob
 * missing a (possibly deeply) nested field keeps its default without anyone
 * having to remember to add a merge line, and a `writeOptions` caller that
 * returns a partial can't silently drop the sibling fields it didn't mention.
 */
function deepMerge(base, patch) {
    if (!isPlainObject(base) || !isPlainObject(patch)) {
        return patch === undefined ? base : patch;
    }
    const result = Object.assign({}, base);
    for (const [key, patchValue] of Object.entries(patch)) {
        if (patchValue === undefined)
            continue;
        result[key] = deepMerge(result[key], patchValue);
    }
    return result;
}
class CalendarPlugin extends obsidian.Plugin {
    async onload() {
        // Feature-image thumbnails are cached as files in this plugin's folder.
        // Skip init if the manifest has no dir (then the feature falls back to
        // rendering full-resolution images, as before).
        if (this.manifest.dir) {
            initThumbnailCache(this.app, obsidian.normalizePath(`${this.manifest.dir}/thumbnail-cache`));
        }
        this.register(settings.subscribe((value) => {
            this.options = value;
        }));
        this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));
        this.addRibbonIcon("calendar-plus", "Open Calendar Plus", () => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
            if (leaves.length) {
                void this.app.workspace.revealLeaf(leaves[0]);
            }
            else {
                this.initLeaf();
            }
        });
        this.addCommand({
            id: "show-calendar-view",
            name: "Open view",
            checkCallback: (checking) => {
                if (checking) {
                    return (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length === 0);
                }
                this.initLeaf();
            },
        });
        this.addCommand({
            id: "open-weekly-note",
            name: "Open Weekly Note",
            checkCallback: (checking) => {
                if (checking) {
                    return this.options.weekly.enabled;
                }
                // Mount the calendar view if needed, then open the weekly note on the
                // freshly-mounted view. Fire-and-forget; no-op if no view can be made.
                void this.ensureCalendarView().then((view) => {
                    void (view === null || view === void 0 ? void 0 : view.openOrCreateWeeklyNote(moment(), false));
                });
            },
        });
        this.addCommand({
            id: "reveal-active-note",
            name: "Reveal active note",
            callback: () => {
                var _a;
                // Don't auto-create — if the user closed the calendar, there's nothing
                // to reveal the note on. Look up the live view fresh each invocation.
                (_a = this.getCalendarView()) === null || _a === void 0 ? void 0 : _a.revealActiveNote();
            },
        });
        await this.loadOptions();
        this.addSettingTab(new CalendarSettingsTab(this.app, this));
        this.app.workspace.onLayoutReady(() => this.initLeaf());
    }
    onunload() {
        // Revoke the in-memory thumbnail object URLs (the cached files on disk
        // persist, which is the point).
        teardownThumbnailCache();
    }
    initLeaf() {
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length) {
            return;
        }
        const right = this.app.workspace.getRightLeaf(false);
        if (!right)
            return;
        void right.setViewState({
            type: VIEW_TYPE_CALENDAR,
        });
    }
    getCalendarView() {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
        if (!leaf)
            return null;
        return leaf.view instanceof CalendarView ? leaf.view : null;
    }
    async ensureCalendarView() {
        const existing = this.getCalendarView();
        if (existing)
            return existing;
        const right = this.app.workspace.getRightLeaf(false);
        if (!right)
            return null;
        await right.setViewState({ type: VIEW_TYPE_CALENDAR });
        return this.getCalendarView();
    }
    async loadOptions() {
        var _a;
        // Backfill defaults for any missing key at any depth. `deepMerge` replaces
        // the old hand-maintained per-object merge, so a new (even deeply) nested
        // setting can't be wiped by a returning user's saved blob.
        const saved = (_a = (await this.loadData())) !== null && _a !== void 0 ? _a : {};
        settings.update((defaults) => deepMerge(defaults, saved));
        await this.saveData(this.options);
    }
    async writeOptions(changeOpts) {
        // deepMerge (not a shallow spread) so a change that returns a nested
        // partial — e.g. { featureImage: { enabled: true } } — preserves the
        // object's other fields rather than dropping them.
        settings.update((old) => deepMerge(old, changeOpts(old)));
        await this.saveData(this.options);
    }
}

module.exports = CalendarPlugin;
