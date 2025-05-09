import { Arguments, Command, CommandConfigOptions, log } from "@lerna/core";
import { repair } from "nx/src/command-line/repair/repair";

const migrationsJson = require("../../../migrations.json");

module.exports = function factory(argv: Arguments<CommandConfigOptions>) {
  return new RepairCommand(argv);
};

class RepairCommand extends Command {
  constructor(argv: Arguments<CommandConfigOptions>) {
    super(argv, { skipValidations: true });
  }

  override initialize() {}

  override async execute() {
    this.configureNxOutput();
    const verbose = this.options?.verbose ? true : log.level === "verbose";

    const lernaMigrations = Object.entries(migrationsJson.generators).map(
      ([name, migration]: [string, any]) => {
        return {
          package: "lerna",
          cli: "nx",
          name,
          description: migration.description,
          version: migration.version,
        } as const;
      }
    );

    await repair({ verbose }, lernaMigrations);
  }

  configureNxOutput() {
    try {
      const nxOutput = require("nx/src/utils/output");
      nxOutput.output.cliName = "Lerna";
      nxOutput.output.formatCommand = (taskId: number) => taskId;
      return nxOutput;
    } catch (err) {
      // TODO: refactor based on TS feedback
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.logger.error("There was a critical issue when trying to execute the repair command.");
      // Rethrow so that the lerna logger can automatically handle the unexpected error
      throw err;
    }
  }
}

module.exports.RepairCommand = RepairCommand;
