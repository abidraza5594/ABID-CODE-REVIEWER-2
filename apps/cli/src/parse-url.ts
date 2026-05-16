/**
 * Parse an Azure DevOps PR URL or a bare PR number into structured coordinates.
 *
 * Accepted forms:
 *   https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
 *   https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<id>
 *   <id>           (bare number — uses ADO_ORG/ADO_PROJECT/ADO_REPO env defaults)
 */
export interface ParsedPr {
  organization: string;
  project: string;
  repo: string;
  pullRequestId: number;
}

export interface ParseDefaults {
  organization?: string;
  project?: string;
  repo?: string;
}

export function parsePrInput(input: string, defaults: ParseDefaults = {}): ParsedPr | { error: string } {
  const trimmed = input.trim();

  // Bare number?
  if (/^\d+$/.test(trimmed)) {
    if (!defaults.organization || !defaults.project || !defaults.repo) {
      return { error: 'Bare PR number used, but ADO_ORG / ADO_PROJECT / ADO_REPO are not all set in .env' };
    }
    return {
      organization: defaults.organization,
      project: defaults.project,
      repo: defaults.repo,
      pullRequestId: Number(trimmed),
    };
  }

  // dev.azure.com form
  const azDev = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(trimmed);
  if (azDev) {
    return {
      organization: decodeURIComponent(azDev[1]!),
      project: decodeURIComponent(azDev[2]!),
      repo: decodeURIComponent(azDev[3]!),
      pullRequestId: Number(azDev[4]!),
    };
  }

  // Legacy visualstudio.com form
  const vs = /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(trimmed);
  if (vs) {
    return {
      organization: decodeURIComponent(vs[1]!),
      project: decodeURIComponent(vs[2]!),
      repo: decodeURIComponent(vs[3]!),
      pullRequestId: Number(vs[4]!),
    };
  }

  return { error: `Could not parse "${input}" as an ADO PR URL or PR number.` };
}
