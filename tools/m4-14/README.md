# M4.14 focused certification evidence

## Run

From the repository root, run `npm run test:m4-14 --workspace=@ca-meta/api` once. The command uses the repository's installed npm workspace dependencies, compiles the API test TypeScript into a private temporary directory, executes only `m4-14-certification-matrix.spec.js`, then removes that directory. It requires the Node/npm workspace already set up for this checkout; it does not install packages or edit the lockfile.

The harness is offline and synthetic. It reads versioned local case references and runs two local contract tests: the all-profile App Review/eligibility release gate, and exact synthetic credential-handle selection/redaction. It makes no Meta/provider requests and sends no messages. It does not create a real credential, use real assets, or perform external effects.

## Evidence map

`apps/api/test/fixtures/m4-14/certification-matrix.v1.json` is the versioned evidence crosswalk for the explicit four flows × seven minimum scenarios. Each cited case includes its exact test name and a bounded assertion summary. The focused spec checks that each citation still names an executable `node:test` case. Every row is `PARTIAL_LOCAL`: targeted contract cases now exist for all 28 cells, while none is claimed as complete end-to-end flow certification. The gap next to each test reference records what remains unproved.

The crosswalk also records the five auth profiles (including both Instagram variants), four synthetic Coexistence phone bindings, Coexistence history/echo no-loop checks, Facebook Page pagination and atomic token enrollment, Instagram variant separation, drift/revocation/lifecycle isolation, and the release-blocking gate. It explicitly leaves real Sandbox, App Review, app/asset eligibility, provider-side deletion/disconnect, and durable Coexistence history import **Not confirmed**.

The runner compiles the API package's test program to keep imports and strict types consistent with the current package. It runs only the M4.14 focused spec. The milestone coordinator runs this command once on the final candidate SHA and records that environment/result; this handoff does not claim that run has already occurred.
