import { describe, expect, it } from "vitest";
import { findingMarker, parseMarker, parseTarget, SUMMARY_MARKER } from "../src/platform/adapter.js";
import { HttpError } from "../src/platform/github.js";

describe("parseTarget", () => {
  it("parses a github.com PR URL", () => {
    const target = parseTarget("https://github.com/earendil-works/pi/pull/482");
    expect(target).toMatchObject({
      platform: "github",
      owner: "earendil-works",
      repo: "pi",
      number: 482,
      apiBase: "https://api.github.com",
    });
  });

  it("tolerates trailing path segments like /files", () => {
    const target = parseTarget("https://github.com/owner/repo/pull/7/files");
    expect(target.number).toBe(7);
  });

  it("routes GitHub Enterprise through /api/v3", () => {
    const target = parseTarget("https://github.acme.com/org/repo/pull/12");
    expect(target.apiBase).toBe("https://github.acme.com/api/v3");
  });

  it("parses a gitlab.com MR URL with the /-/ separator", () => {
    const target = parseTarget("https://gitlab.com/group/sub/repo/-/merge_requests/45");
    expect(target).toMatchObject({
      platform: "gitlab",
      owner: "group/sub",
      repo: "repo",
      number: 45,
      apiBase: "https://gitlab.com/api/v4",
    });
  });

  it("parses the older GitLab URL style without /-/", () => {
    const target = parseTarget("https://gitlab.example.com/group/repo/merge_requests/9");
    expect(target).toMatchObject({ owner: "group", repo: "repo", number: 9 });
    expect(target.apiBase).toBe("https://gitlab.example.com/api/v4");
  });

  it("rejects a URL with no PR number", () => {
    expect(() => parseTarget("https://github.com/owner/repo")).toThrow(/Unrecognized/);
  });

  it("rejects a non-URL", () => {
    expect(() => parseTarget("owner/repo#1")).toThrow(/Not a URL/);
  });
});

describe("comment markers", () => {
  it("round-trips a finding fingerprint", () => {
    const body = `Some review text\n\n${findingMarker("a1b2c3d4e5")}`;
    expect(parseMarker(body)).toEqual({ fingerprint: "a1b2c3d4e5", isSummary: false });
  });

  it("recognizes the summary marker", () => {
    expect(parseMarker(`Report\n${SUMMARY_MARKER}`)).toEqual({ isSummary: true });
  });

  it("returns nothing for a human comment", () => {
    expect(parseMarker("looks good to me")).toEqual({ isSummary: false });
  });
});

describe("what a failed request tells the person who ran it", () => {
  it("names the pull request instead of quoting GitHub's JSON", () => {
    // Mistyping a number used to print the REST response body, including a link
    // to documentation for an endpoint the user never knowingly called.
    const error = new HttpError(
      404,
      "https://api.github.com/repos/acme/widgets/pulls/99999",
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}',
    );
    expect(error.message).toContain("acme/widgets #99999");
    expect(error.message).not.toContain("documentation_url");
  });

  it("says a private repository is indistinguishable from a missing one", () => {
    const error = new HttpError(404, "https://api.github.com/repos/acme/secret/pulls/1", "");
    expect(error.message).toMatch(/private/i);
  });

  it("points at the credentials on 401", () => {
    const error = new HttpError(401, "https://api.github.com/repos/a/b/pulls/1", "");
    expect(error.message).toMatch(/GITHUB_TOKEN|gh auth login/);
  });

  it("keeps the raw body for a status it has nothing better to say about", () => {
    const error = new HttpError(500, "https://api.github.com/x", "upstream exploded");
    expect(error.message).toContain("upstream exploded");
  });
})
