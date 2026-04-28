# Vendored PIP Labs Dependencies

This directory contains vendored third-party code used by the API worker.

## `cdr-crypto/`

- Package name: `@piplabs/cdr-crypto`
- Package version: `0.1.0`
- Runtime consumer: `services/api/src/lib/story/story-cdr.ts`
- Runtime purpose: TDH2 threshold encryption and partial-decryption helpers for CDR story publishing.
- Upstream cryptographic implementation: Coinbase `cb-mpc` TDH2 / WASM artifacts.
- Exact source URL / commit: not recorded in the vendored package metadata.
- License: not recorded in the vendored package metadata.

Do not update these files without recording the upstream source URL, upstream commit or release,
license, build command, and refreshed SHA-256 checksums below.

## SHA-256 Checksums

Checksums were generated from `services/api/src/vendor/piplabs/cdr-crypto/`.

```text
cdc4cc225a1ff7dc5b6d52821f2094c57631000452aac811e0846e635c8d8b3d  ./ecies.d.ts
f4ca3f294cab4a03a6900d899ff732c13ebf85883265868788f848e189c80e9b  ./ecies.d.ts.map
c65db4a4caa7084170a42b4154a25f6971963a315db6706cefd6ba80232a4dba  ./ecies.js
d09b3d1696859e462ee4eefe4afd287e2c29484b4433c744a2d7d69ea9e46ca5  ./ecies.js.map
fa12b40c9f9031351dc2b48af325af28c27e7392f5233707f87c7ecd5654a529  ./errors.d.ts
db15dbfbc64a9615c99a545339f70af317f74fa5aac868cbddd2712ee9b46b60  ./errors.d.ts.map
2ec06e147f9bd89b8769be43be68948526bf4f2843dce6b2afa425eec5f41488  ./errors.js
155d7de26cf03462b715a2aebe3ec6961a598b5f33f33e1561cd33afbc207f0a  ./errors.js.map
81de26f6813cfe87e73ac123135c2df3eb646daeaef4b02629f89b7d1bb8b6de  ./index.d.ts
7a67137832e5a893fae26b76478d00e4f5a310a67bccc36c9139756a0db6933c  ./index.d.ts.map
736a99594541d0d60539b9413453c3478ba7f04319587e92404c726f82d8ee26  ./index.js
5414cf0264940ae4b04357e1eeea9333f1e7c130ddd18414e85726ebf7bcb075  ./index.js.map
ecde941917708297952ca97a897f8ae4e92eb3922fc3e31c60b3375dd63b572d  ./package.json
d15b2631835ad1976b161043e3f1f57cf6013251c448ecdff5c0044559df1d2e  ./signature.d.ts
8d051e0a9c9af476c3974e010e4f4c9f606d8cdc1ea6b3fc51b9c65eac855cae  ./signature.d.ts.map
0ccbf8d0095c43e3cc4430f487ae11aa48d68e1cd3f76ac5cb494fd16ef6dbdd  ./signature.js
51e464af97895abdc16b4ea9cedefd39dd81e034c2d4bdc8869d473eb42be368  ./signature.js.map
9b061015bf9d4303d8696bdd78ae5b7c8df665a645ec9138e84e86ebfdad3004  ./tdh2.d.ts
ca65e6e5568c5a60ac53ce0faf4dc0f45ebdfbf52d3995d83c23cd73b715d2f7  ./tdh2.d.ts.map
4c8697ef20abfb772a0939b76c8218e1ec30e7bb8f89d018623fbbaf3433e352  ./tdh2.js
2cc2c512a71ddcaad91423dc81008d4aa08c96d5b3a87cd7f62b2b8c4645cf75  ./tdh2.js.map
de57b7f98f85c4d37ee4426b69ae206e0bb2316a09bb5d88d5b7b9dd1a8f86a0  ./types.d.ts
3136757f20b30fdccaeb16dd32585e4ccf89056ac4870fdc0b57b26d54c9fb75  ./types.d.ts.map
01ae2a5b120382f9a648ced7ee8507493a134f216d100fc61600c6c9738235d2  ./types.js
a7de897b48fe57bf54d6f84169135ff2e89e2fc95ea0a0a815761cc29a41efee  ./types.js.map
f23a647cb2de2c4ffbcb349b53b982d57bf1df4a0e49003d0d00e372d56528d8  ./wasm/cb-mpc-tdh2.js
1ffbe6366d89c33102c86e108e679f9592016b23fd31f09b0be4ad2e4b14ae9e  ./wasm/cb-mpc-tdh2.wasm
94159422cdd88d90341bc5768a0d1f1af8a22d1b1d504aac15e766371b867ec4  ./wasm/loader.d.ts
bcee6c5449c3c282cb7d874c0430504331fb1c6eb6d345d20da61d9ea8003077  ./wasm/loader.d.ts.map
2dd055d73eb2ef13bab6f5bfdef552514494765cd95707f3d92f7f5d5c7f6787  ./wasm/loader.js
9a03e7e28d158ea0c2ec60c70cde5f4d09bf43166f2e7610d126e508516e0f28  ./wasm/loader.js.map
```
