import { readFile } from "node:fs/promises";
import { EvidenceRef, MAX_PROPOSAL_BYTES, TreeHash, type ProposalSubmission } from "@quench/fleet";
import type { Home } from "@quench/history";
import { binary, unifiedDiff } from "@quench/hub";
import { clientDir, hubSkill, hubSkills, submitProposal } from "@quench/hub/client";

export type SkillOptions = {
  json: boolean;
  base?: string;
  agent?: string;
  harness?: string;
  session: string[];
  evidence: string[];
};

const USAGE = `usage: quench skill list [--json]
       quench skill show <skill> [--json]
       quench skill diff <skill> <file>
       quench skill propose <skill> <file> [--base sha256:…] [--agent <name>] [--harness <id>]
                            [--session <id>] [--evidence <json>]... [--json]
`;

const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

async function plainText(file: string) {
  const bytes = await readFile(file);
  if (bytes.length > MAX_PROPOSAL_BYTES)
    throw new Error(`${file} is over ${MAX_PROPOSAL_BYTES} bytes; a proposal must be smaller`);
  const text = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  })();
  if (text === null || binary(text))
    throw new Error(`${file} is not plain UTF-8 text; a proposal is one plain-text SKILL.md`);
  return text;
}

function submission(name: string, content: string, base: string, options: SkillOptions) {
  if (options.session.length > 1) throw new Error("propose takes one --session");
  const claims = {
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.session[0] ? { session: options.session[0] } : {}),
  };
  const evidence = options.evidence.map((raw) => {
    const parsed = EvidenceRef.safeParse(
      (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success)
      throw new Error(
        `--evidence must be JSON like {"kind":"eval-summary","name":"…","counts":{"pass":3}}`,
      );
    return parsed.data;
  });
  const submitted: ProposalSubmission = {
    skill: name,
    baseTreeHash: base,
    file: "SKILL.md",
    content,
    claims,
    evidence,
  };
  return submitted;
}

export async function skill(home: Home, rest: string[], options: SkillOptions) {
  const [sub, name, file, ...extra] = rest;
  const dir = clientDir(home.dir);
  try {
    if (sub === "list" && !name) {
      const listed = await hubSkills(dir);
      if (options.json) out(JSON.stringify(listed));
      else if (!listed.skills.length) out(`No skills are assigned to ${listed.machine}.`);
      else for (const s of listed.skills) out(`${s.name}  ${s.treeHash}`);
      return 0;
    }
    if (sub === "show" && name && !file) {
      const found = await hubSkill(dir, name);
      out(options.json ? JSON.stringify(found) : found.content);
      return 0;
    }
    if (sub === "diff" && name && file && !extra.length) {
      const found = await hubSkill(dir, name);
      const diff = unifiedDiff(found.content, await plainText(file), `${found.path}/SKILL.md`);
      out(diff || `No changes from ${name} at ${found.treeHash}.`);
      return 0;
    }
    if (sub === "propose" && name && file && !extra.length) {
      if (options.base !== undefined && !TreeHash.safeParse(options.base).success)
        throw new Error("--base must look like sha256:<64 hex characters>");
      const content = await plainText(file);
      const base = options.base ?? (await hubSkill(dir, name)).treeHash;
      const receipt = await submitProposal(dir, submission(name, content, base, options));
      if (options.json) out(JSON.stringify(receipt));
      else {
        const kinds = [...new Set(receipt.flags.map((f) => f.kind))];
        out(
          `Proposal #${receipt.id} for ${receipt.skill} is waiting for the owner's review.\nBase ${receipt.baseTreeHash}, revision ${receipt.revision}.${kinds.length ? `\nThe owner will see flags for: ${kinds.join(", ")}.` : ""}`,
        );
      }
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  process.stderr.write(USAGE);
  return 1;
}
