# v0.2.1 interface acceptance

- Replaced independent green palette with installed DSH semantic color tokens; corrected nonexistent background token to --dsw-alias-bg-base.
- Matched native plugin page width (960px), header typography (20px/28px), macOS frame clearance, segmented tabs and neutral buttons.
- Flattened cards to settings sections. Voice choice and audition are primary; creation and prompt preview are progressive disclosures. No backend, recognition or synthesis changes.
- npm run check:46 tests passed, TypeScript and production bundle build passed.
- Isolated browser loaded actual installed DSH theme CSS. Dark: page/body rgb(21,21,23), heading rgb(249,250,251). Light: page/body rgb(255,255,255), heading rgb(15,17,21).
- Persona preset and native-config-compatible save flow succeeded. Creation disclosure expanded, all settings retained. At390px, page/body width390px with no horizontal overflow; connection inputs fit350px content width.
