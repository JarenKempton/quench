import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

const length = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);

const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
};

const sequence = (...parts: Uint8Array[]) => tlv(0x30, ...parts);

const oid = (dotted: string) => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const n of rest) {
    const arc = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) arc.unshift((v & 0x7f) | 0x80);
    bytes.push(...arc);
  }
  return tlv(0x06, Buffer.from(bytes));
};

const generalizedTime = (date: Date) =>
  tlv(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`));

const ipv6 = (ip: string) => {
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
};

const altName = (name: string) =>
  isIP(name) === 4
    ? tlv(0x87, Buffer.from(name.split(".").map(Number)))
    : isIP(name) === 6
      ? tlv(0x87, Buffer.from(ipv6(name)))
      : tlv(0x82, Buffer.from(name));

const pem = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/.{64}/g, "$&\n")
    .replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;

export const spkiPin = (cert: string | Uint8Array) =>
  `sha256:${createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;

export function selfSignedCertificate(names: string[], now = new Date()) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const subject = sequence(
    tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from("quench hub")))),
  );
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    algorithm,
    subject,
    sequence(
      generalizedTime(new Date(now.getTime() - 3_600_000)),
      generalizedTime(new Date(now.getTime() + 3650 * 86_400_000)),
    ),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(
      0xa3,
      sequence(
        sequence(oid("2.5.29.17"), tlv(0x04, sequence(...[...new Set(names)].map(altName)))),
        sequence(oid("2.5.29.19"), tlv(0x04, sequence())),
      ),
    ),
  );
  const der = sequence(
    tbs,
    algorithm,
    tlv(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)),
  );
  return {
    cert: pem(der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
