# `@hypit/project-context-node`

Shared project and Runtime selection for Node entrypoints: CLI, Studio and creation tools.
This package resolves locations and reads or explicitly changes the project's Runtime pointer.
It does not load Providers, install programs, inspect credentials or select services.

1. `resolveProjectRoot({ workspaceRoot?, cwd? })` uses the explicit Workspace, otherwise the nearest
   `package.json` above cwd, otherwise cwd itself. Source and Run filenames do not choose the project.
2. `resolveCreativeProjectRoot({ workspaceRoot?, cwd?, distributionRoot? })` applies the same resolution,
   then redirects a Hypit source checkout away from `examples/` and the repository root into
   `projects/<slug>/`, scaffolding `package.json`, `hypit.runtime.json` and a Runtime selection when needed.
3. `findRuntimeProfile(projectRoot)` reads only that project's `.hypit/runtime` file and resolves its
   path relative to the project. An entrypoint's explicit `--runtime` overrides this read for that invocation.
4. The selected Runtime implementation interprets the Profile, including `dataRoot`, Credentials,
   Providers and capability bindings. This package does not interpret its contents.

`selectRuntimeProfile(projectRoot, profile)` writes the explicit choice; `clearRuntimeProfile` removes
only that pointer. A directory occupying the pointer path is reported without replacing it. Runtime
working data belongs at the Profile's separate `dataRoot`.

Project packages, the installed Distribution and machine-managed executables have different owners.
The Distribution supplies code; it does not supply a second project environment. Provider adapters
resolve their executable configuration and report availability through the Runtime's existing ports.
