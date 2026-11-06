import { crc32, deflateRawSync } from "node:zlib";

/**
 * A minimal zip writer for tests: stored or deflated entries, with ways to lie about a header
 * (declared size, CRC, a symbolic link, an encrypted flag) to prove the reader refuses them.
 */
export interface TestEntry {
  readonly name: string;
  readonly data?: string | Buffer;
  readonly store?: boolean;
  readonly declaredSize?: number;
  readonly crc?: number;
  readonly symlink?: boolean;
  readonly encrypted?: boolean;
  /** Write the name without the UTF-8 flag. */
  readonly latin1?: boolean;
}

export function buildZip(entries: readonly TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const method = e.store || e.name.endsWith("/") ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, e.latin1 ? "latin1" : "utf8");
    const flags = (e.latin1 ? 0 : 0x0800) | (e.encrypted ? 1 : 0);
    const crc = e.crc ?? crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.symlink ? 0o120777 : e.name.endsWith("/") ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export const SCORM12_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="fire-safety-1" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1"><title>Fire safety</title>
      <item identifier="i1" identifierref="r1"><title>Lesson</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="index.html?lang=en"><file href="index.html"/></resource>
  </resources>
</manifest>`;

export const SCORM2004_MANIFEST = SCORM12_MANIFEST.replace(
  "<schemaversion>1.2</schemaversion>",
  "<schemaversion>2004 4th Edition</schemaversion>",
)
  .replace('href="index.html?lang=en"', 'xml:base="course/" href="start.html"')
  .replace("adlcp:scormtype", "adlcp:scormType");

export const TINCAN = `<?xml version="1.0" encoding="UTF-8"?>
<tincan xmlns="http://projecttincan.com/tincan.xsd"><activities>
  <activity id="https://courses.example.invalid/fire" type="http://adlnet.gov/expapi/activities/course">
    <name>Fire safety</name><launch lang="en-GB">story.html</launch>
  </activity>
</activities></tincan>`;

export const SCORM12_PACKAGE = () =>
  buildZip([
    { name: "imsmanifest.xml", data: SCORM12_MANIFEST },
    {
      name: "index.html",
      data: "<!doctype html><title>Fire safety</title><script src=app.js></script>",
    },
    { name: "app.js", data: "var api = window.parent.API;" },
    { name: "img/", data: "" },
  ]);
