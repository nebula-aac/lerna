import {
  Command,
  CommandConfigOptions,
  FilterOptions,
  filterProjects,
  generateProfileOutputPath,
  getPackage,
  npmRunScript,
  npmRunScriptStreaming,
  output,
  Package,
  Profiler,
  ProjectGraphProjectNodeWithPackage,
  runProjectsTopologically,
  timer,
  ValidationError,
  Arguments,
} from "@lerna/core";
import { TargetDependencyConfig } from "@nx/devkit";
import { existsSync } from "fs-extra";

import { runMany } from "nx/src/command-line/run-many/run-many";
import { runOne } from "nx/src/command-line/run/run-one";
import pMap from "p-map";
import path from "path";
import { performance } from "perf_hooks";

export function factory(argv: Arguments<RunCommandConfigOptions>) {
  return new RunCommand(argv);
}

export interface RunCommandConfigOptions extends CommandConfigOptions, FilterOptions {
  script: string | string[];
  profile?: boolean;
  profileLocation?: string;
  bail?: boolean;
  prefix?: boolean;
  loadEnvFiles?: boolean;
  parallel?: boolean;
  rejectCycles?: boolean;
  skipNxCache?: boolean;
  "--"?: string[];
}

export class RunCommand extends Command<RunCommandConfigOptions> {
  script: string | string[] = "";
  args?: string[];
  npmClient?: string;
  bail?: boolean;
  prefix?: boolean;
  projectsWithScript: ProjectGraphProjectNodeWithPackage[] = [];
  count?: number;
  packagePlural?: string;
  joinedCommand?: string;

  override get requiresGit() {
    return false;
  }

  override async initialize() {
    const { script, npmClient = "npm", bail, prefix } = this.options;

    this.script = script;
    this.args = this.options["--"] || [];
    this.npmClient = npmClient;

    if (!this.script) {
      throw new ValidationError("ENOSCRIPT", "You must specify a lifecycle script to run");
    }

    // Check this.argv (not this.options) so that we only error in this case when --npm-client is set via the CLI (not via lerna.json which is a legitimate use case for other things)
    if ((this.argv as unknown as RunCommandConfigOptions).npmClient && this.options.useNx !== false) {
      throw new ValidationError(
        "run",
        "The legacy task runner option `--npm-client` is not currently supported. Please open an issue on https://github.com/lerna/lerna if you require this feature."
      );
    }

    // Only the modern task runner supports multiple targets concurrently
    if (Array.isArray(this.script) && this.options.useNx === false) {
      throw new ValidationError(
        "run",
        "The legacy task runner does not support running multiple scripts concurrently. Please update to the latest version of lerna and ensure you do not have useNx set to false in your lerna.json."
      );
    }

    // inverted boolean options
    this.bail = bail !== false;
    this.prefix = prefix !== false;

    const filteredProjects = filterProjects(this.projectGraph, this.execOpts, this.options);

    this.projectsWithScript =
      script === "env"
        ? filteredProjects
        : filteredProjects.filter((project) => {
            if (Array.isArray(this.script)) {
              return this.script.some((scriptName) => project.data.targets?.[scriptName]);
            }
            return project.data.targets?.[this.script ?? ""];
          });

    this.count = this.projectsWithScript.length;
    this.packagePlural = this.count === 1 ? "package" : "packages";
    this.joinedCommand = [this.npmClient, "run", this.script].concat(this.args).join(" ");

    if (!this.count) {
      this.logger.success("run", `No packages found with the lifecycle script '${script}'`);

      // still exits zero, aka "ok"
      return false;
    }
    return true;
  }

  override async execute() {
    if (this.options.useNx === false) {
      this.logger.info(
        "",
        "Executing command in %d %s: %j",
        this.count,
        this.packagePlural,
        this.joinedCommand
      );
    }

    const getElapsed = timer();

    let runScripts: () => Promise<unknown>;
    if (this.options.useNx !== false) {
      runScripts = () => this.runScriptsUsingNx();
    } else if (this.options.parallel) {
      runScripts = () => this.runScriptInPackagesParallel();
    } else if (this.toposort) {
      runScripts = () => this.runScriptInPackagesTopological();
    } else {
      runScripts = () => this.runScriptInPackagesLexical();
    }

    if (this.bail) {
      // only the first error is caught
      try {
        await runScripts();
      } catch (err: any) {
        process.exitCode = err.exitCode;

        // rethrow to halt chain and log properly
        throw err;
      }
    } else {
      // detect error (if any) from collected results
      const results = (await runScripts()) as { failed: boolean; exitCode: number }[];
      if (results.some((result) => result.failed)) {
        // propagate "highest" error code, it's probably the most useful
        const codes = results.filter((result) => result.failed).map((result) => result.exitCode);
        const exitCode = Math.max(...codes, 1);

        this.logger.error("", "Received non-zero exit code %d during execution", exitCode);
        process.exitCode = exitCode;
      }
    }

    this.logger.success(
      "run",
      "Ran npm script '%s' in %d %s in %ss:",
      this.script,
      this.count,
      this.packagePlural,
      (getElapsed() / 1000).toFixed(1)
    );
    this.logger.success("", this.projectsWithScript.map((p) => `- ${getPackage(p).name}`).join("\n"));
  }

  private getOpts(pkg: Package) {
    // these options are NOT passed directly to execa, they are composed in npm-run-script
    return {
      args: this.args,
      npmClient: this.npmClient,
      prefix: this.prefix,
      reject: this.bail,
      pkg,
    };
  }

  private getRunner() {
    return this.options.stream
      ? (pkg: Package) => this.runScriptInPackageStreaming(pkg)
      : (pkg: Package) => this.runScriptInPackageCapturing(pkg);
  }

  private runScriptInPackagesTopological() {
    let profiler: Profiler | undefined;
    let runner: (pkg: Package) => Promise<unknown>;

    if (this.options.profile) {
      profiler = new Profiler({
        concurrency: this.concurrency,
        log: this.logger,
        outputDirectory: this.options.profileLocation,
      });

      const callback = this.getRunner();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      runner = (pkg: Package) => profiler!.run(() => callback(pkg), pkg.name);
    } else {
      runner = this.getRunner();
    }

    let chain = runProjectsTopologically(
      this.projectsWithScript,
      this.projectGraph,
      (p) => runner(getPackage(p)),
      {
        concurrency: this.concurrency,
        rejectCycles: this.options.rejectCycles,
      }
    );

    if (profiler) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      chain = chain.then((results) => profiler!.output().then(() => results));
    }

    return chain;
  }

  private runScriptInPackagesParallel() {
    return pMap(this.projectsWithScript, (p) => this.runScriptInPackageStreaming(getPackage(p)));
  }

  private runScriptInPackagesLexical() {
    return pMap(this.projectsWithScript, (p) => this.getRunner()(getPackage(p)), {
      concurrency: this.concurrency,
    });
  }

  private runScriptInPackageStreaming(pkg: Package) {
    // script can only be a string when using the legacy task runner
    return npmRunScriptStreaming(this.script as string, this.getOpts(pkg));
  }

  private runScriptInPackageCapturing(pkg: Package) {
    const getElapsed = timer();
    // script can only be a string when using the legacy task runner
    return npmRunScript(this.script as string, this.getOpts(pkg)).then((result: { stdout: string }) => {
      this.logger.info(
        "run",
        "Ran npm script '%s' in '%s' in %ss:",
        this.script,
        pkg.name,
        (getElapsed() / 1000).toFixed(1)
      );
      output(result.stdout);

      return result;
    });
  }

  private async runScriptsUsingNx() {
    if (this.options.ci) {
      process.env["CI"] = "true";
    }
    if (this.options.profile) {
      const absolutePath = generateProfileOutputPath(this.options.profileLocation);
      // Nx requires a workspace relative path for this
      process.env["NX_PROFILE"] = path.relative(this.project.rootPath, absolutePath);
    }
    performance.mark("init-local");
    this.configureNxOutput();
    const { targetDependencies, options, extraOptions } = await this.prepNxOptions();

    if (this.projectsWithScript.length === 1 && !Array.isArray(this.script)) {
      const fullQualifiedTarget =
        this.projectsWithScript.map((p) => p.name)[0] +
        ":" +
        this.addQuotesAroundScriptNameIfItHasAColon(this.script);
      return runOne(
        process.cwd(),
        {
          "project:target:configuration": fullQualifiedTarget,
          ...options,
        },
        targetDependencies,
        extraOptions
      );
    } else {
      const projects = this.projectsWithScript.map((p) => p.name).join(",");
      return runMany(
        {
          projects,
          targets: Array.isArray(this.script) ? this.script : [this.script],
          ...options,
        },
        targetDependencies,
        extraOptions
      );
    }
  }

  private addQuotesAroundScriptNameIfItHasAColon(scriptName: string) {
    // Nx requires quotes around script names of the form script:name
    if (scriptName.includes(":")) {
      return `"${scriptName}"`;
    } else {
      return scriptName;
    }
  }

  private async prepNxOptions() {
    const nxJsonExists = existsSync(path.join(this.project.rootPath, "nx.json"));

    const { readNxJson } = require("nx/src/config/configuration");
    const nxJson = readNxJson();
    const targetDependenciesAreDefined =
      Object.keys(nxJson.targetDependencies || nxJson.targetDefaults || {}).length > 0;

    const hasProjectSpecificNxConfiguration = this.projectsWithScript.some((p) => !!getPackage(p).get("nx"));
    const hasCustomizedNxConfiguration =
      (nxJsonExists && targetDependenciesAreDefined) || hasProjectSpecificNxConfiguration;
    const mimicLernaDefaultBehavior = !hasCustomizedNxConfiguration;

    const targetDependencies: Record<string, TargetDependencyConfig[]> =
      this.toposort && !this.options.parallel && mimicLernaDefaultBehavior && !Array.isArray(this.script)
        ? {
            [this.script]: [
              {
                dependencies: true,
                target: this.script,
              },
            ],
          }
        : {};

    if (this.options.prefix === false && !this.options.stream) {
      this.logger.warn(this.name, `"no-prefix" is ignored when not using streaming output.`);
    }

    const outputStyle = this.options.stream
      ? this.prefix
        ? "stream"
        : "stream-without-prefixes"
      : "dynamic";

    const options = {
      outputStyle,
      /**
       * To match lerna's own behavior (via pMap's default concurrency), we set parallel to a very large number if
       * the flag has been set (we can't use Infinity because that would cause issues with the task runner).
       */
      parallel: this.options.parallel && mimicLernaDefaultBehavior ? 999 : this.concurrency,
      nxBail: this.bail,
      nxIgnoreCycles: !this.options.rejectCycles,
      skipNxCache: this.options.skipNxCache,
      verbose: this.options.verbose,
      __overrides__: this.args?.map((t) => t.toString()),
    };

    if (hasCustomizedNxConfiguration) {
      this.logger.verbose(
        this.name,
        "Nx target configuration was found. Task dependencies will be automatically included."
      );

      if (this.options.parallel || this.options.sort !== undefined) {
        this.logger.warn(
          this.name,
          `"parallel", "sort", and "no-sort" are ignored when Nx targets are configured. See https://lerna.js.org/docs/lerna6-obsolete-options for details.`
        );
      }

      if (this.options.includeDependencies) {
        this.logger.info(
          this.name,
          `Using the "include-dependencies" option when Nx targets are configured will include both task dependencies detected by Nx and project dependencies detected by Lerna. See https://lerna.js.org/docs/lerna6-obsolete-options#--include-dependencies for details.`
        );
      }

      if (this.options.ignore) {
        this.logger.info(
          this.name,
          `Using the "ignore" option when Nx targets are configured will exclude only tasks that are not determined to be required by Nx. See https://lerna.js.org/docs/lerna6-obsolete-options#--ignore for details.`
        );
      }
    } else {
      this.logger.verbose(
        this.name,
        "Nx target configuration was not found. Task dependencies will not be automatically included."
      );
    }

    const extraOptions = {
      excludeTaskDependencies: mimicLernaDefaultBehavior,
      loadDotEnvFiles: this.options.loadEnvFiles ?? true,
    };

    return { targetDependencies, options, extraOptions };
  }

  private configureNxOutput() {
    try {
      const nxOutput = require("nx/src/utils/output");
      nxOutput.output.cliName = "Lerna (powered by Nx)";
      nxOutput.output.formatCommand = (taskId: string) => taskId;
      return nxOutput;
    } catch (err) {
      // This should be unreachable and we would want to know if it somehow occurred in a user's setup.
      this.logger.error(
        "\n",
        "There was a critical error when configuring the task runner, please report this on https://github.com/lerna/lerna"
      );
      throw err;
    }
  }
}
