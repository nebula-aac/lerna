import {
  createGitHubClient as _createGitHubClient,
  createGitLabClient as _createGitLabClient,
  recommendVersion as _recommendVersion,
} from "@lerna/core";
import { commandRunner, initFixtureFactory } from "@lerna/test-helpers";

jest.mock("@lerna/core", () => require("@lerna/test-helpers/__mocks__/@lerna/core"));

jest.mock("./git-add");
jest.mock("./git-commit");
jest.mock("./git-push");
jest.mock("./is-anything-committed", () => ({
  isAnythingCommitted: jest.fn().mockReturnValue(true),
}));
jest.mock("./is-behind-upstream", () => ({
  isBehindUpstream: jest.fn().mockReturnValue(false),
}));
jest.mock("./remote-branch-exists", () => ({
  remoteBranchExists: jest.fn().mockResolvedValue(true),
}));

jest.mock("execa", () => {
  const execa = jest.requireActual("execa");

  const mockExeca = (...args) => {
    // assume there are changes if git diff is called
    if (
      args[0] === "git" &&
      args[1].length === 3 &&
      args[1][0] === "diff" &&
      args[1][1] === "--staged" &&
      args[1][2] === "--quiet"
    ) {
      return Promise.reject(new Error("Changes found"));
    }

    return execa(...args);
  };

  return Object.assign(mockExeca, execa);
});

// The mocked version isn't the same as the real one
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createGitHubClient = _createGitHubClient as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createGitLabClient = _createGitLabClient as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recommendVersion = _recommendVersion as any;

const initFixture = initFixtureFactory(__dirname);

// test command

const lernaVersion = commandRunner(require("../command"));

describe.each([
  ["github", createGitHubClient],
  ["gitlab", createGitLabClient],
])("--create-release %s", (type, client) => {
  it("does not create a release if --no-push is passed", async () => {
    const cwd = await initFixture("independent");

    await lernaVersion(cwd)("--create-release", type, "--conventional-commits", "--no-push");

    expect(client.releases.size).toBe(0);
  });

  it("throws an error if --conventional-commits is not passed", async () => {
    const cwd = await initFixture("independent");
    const command = lernaVersion(cwd)("--create-release", type);

    await expect(command).rejects.toThrow("To create a release, you must enable --conventional-commits");

    expect(client.releases.size).toBe(0);
  });

  it("throws an error if --no-changelog also passed", async () => {
    const cwd = await initFixture("independent");
    const command = lernaVersion(cwd)("--create-release", type, "--conventional-commits", "--no-changelog");

    await expect(command).rejects.toThrow("To create a release, you cannot pass --no-changelog");

    expect(client.releases.size).toBe(0);
  });

  it("throws an error if environment variables are not present", async () => {
    const cwd = await initFixture("normal");
    const command = lernaVersion(cwd)("--create-release", type, "--conventional-commits");
    const message = `Environment variables for ${type} are missing!`;

    client.mockImplementationOnce(() => {
      throw new Error(message);
    });

    await expect(command).rejects.toThrow(message);

    expect(client.releases.size).toBe(0);
  });

  it("marks a version as a pre-release if it contains a valid part", async () => {
    const cwd = await initFixture("normal");

    recommendVersion.mockResolvedValueOnce("2.0.0-alpha.1");

    await lernaVersion(cwd)("--create-release", type, "--conventional-commits");

    expect(client.releases.size).toBe(1);
    expect(client.releases.get("v2.0.0-alpha.1")).toEqual({
      owner: "lerna",
      repo: "lerna",
      tag_name: "v2.0.0-alpha.1",
      name: "v2.0.0-alpha.1",
      body: "normal",
      draft: false,
      prerelease: true,
    });
  });

  it("creates a release for every independent version", async () => {
    const cwd = await initFixture("independent");
    const versionBumps = new Map([
      ["package-1", "1.0.1"],
      ["package-2", "2.1.0"],
      ["package-3", "4.0.0"],
      ["package-4", "4.1.0"],
      ["package-5", "5.0.1"],
      ["package-6", "0.2.0"],
    ]);

    versionBumps.forEach((bump) => recommendVersion.mockResolvedValueOnce(bump));

    await lernaVersion(cwd)("--create-release", type, "--conventional-commits");

    expect(client.releases.size).toBe(6);
    versionBumps.forEach((version, name) => {
      expect(client.releases.get(`${name}@${version}`)).toEqual({
        owner: "lerna",
        repo: "lerna",
        tag_name: `${name}@${version}`,
        name: `${name}@${version}`,
        body: `${name} - ${version}`,
        draft: false,
        prerelease: false,
      });
    });
  });

  it("creates a single fixed release", async () => {
    const cwd = await initFixture("normal");

    recommendVersion.mockResolvedValueOnce("1.1.0");

    await lernaVersion(cwd)("--create-release", type, "--conventional-commits");

    expect(client.releases.size).toBe(1);
    expect(client.releases.get("v1.1.0")).toEqual({
      owner: "lerna",
      repo: "lerna",
      tag_name: "v1.1.0",
      name: "v1.1.0",
      body: "normal",
      draft: false,
      prerelease: false,
    });
  });
});

describe("legacy option --github-release", () => {
  it("should error when --github-release is used", async () => {
    const testDir = await initFixture("normal");
    await expect(
      lernaVersion(testDir)("--github-release", "--conventional-commits")
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `"--github-release was replaced by --create-release=github. We recommend running \`lerna repair\` in order to ensure your lerna.json is up to date, otherwise check your CLI usage and/or any configs you extend from."`
    );
  });
});

describe("--create-release [unrecognized]", () => {
  it("throws an error", async () => {
    const cwd = await initFixture("normal");
    const command = lernaVersion(cwd)("--conventional-commits", "--create-release", "poopypants");

    await expect(command).rejects.toThrow("create-release");

    expect(createGitHubClient.releases.size).toBe(0);
    expect(createGitLabClient.releases.size).toBe(0);
  });
});
