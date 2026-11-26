# Traein mobile

The Expo app uses the same GraphQL and Clerk-backed account API as the dashboard.

## Run in Expo Go

From the repository root:

```sh
cd mobile
pnpm install
cp .env.example .env.local
pnpm start
```

Open the QR code in an Expo Go build that supports SDK 58. Keep the phone and development machine on the same network. The train and bus maps use Apple Maps on iOS and Google Maps on Android through `react-native-maps`. Expo Go provides both. A standalone Android build needs its own Google Maps SDK key.

- `EXPO_PUBLIC_API_URL` defaults to `https://traein.semyon.ie`. For a local API, use an address the phone can reach.
- `EXPO_PUBLIC_ENABLE_ACCOUNT` turns the Account tab on when set to `true`. It is off by default. Once an allowlist is set, the API rejects Clerk tokens without an allowed `azp` claim, as Clerk's own backend SDK does, and nobody has checked what a native session token carries yet. Sign in on a device and decode a token first. If it has an `azp`, add that value to `CLERK_AUTHORIZED_PARTIES`. If it has none, native sign-in needs a different design, because accepting a missing `azp` is the gap Clerk closed in July 2026.
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is only read when the account flag is on, and is optional for public transport data. Set it to the publishable key for the API’s Clerk instance and enable email code sign-in for existing accounts. The app stores the native Clerk session in SecureStore and sends its bearer token to `/auth/me` and GraphQL. Before turning the flag on, check that the API accepts native sessions. Registration, other sign-in methods and billing are handled by the dashboard.

For browser development use `pnpm start --web`. Leaflet provides the web map. A browser on a different origin needs an API that allows that origin via CORS.

## Builds and over-the-air updates

Builds and JS updates go through EAS. Store builds come from `eas build`. Changes that only touch JS, styles or assets ship as updates with no store review.

One-time setup, with an Expo account that owns the project:

```sh
pnpm dlx eas-cli login
pnpm dlx eas-cli init
pnpm dlx eas-cli update:configure
```

`init` writes the project id into `app.json`, and `update:configure` adds the update URL.

Each build profile in `eas.json` maps to a channel of the same name. `preview` is an internal build for testers and `production` goes to the stores.

```sh
pnpm dlx eas-cli build --profile preview --platform all
pnpm dlx eas-cli build --profile production --platform all
```

Publishing an update:

```sh
pnpm run update:preview               # every preview install
pnpm run update:production            # 10% of production installs
pnpm dlx eas-cli update:edit         # raise the rollout percentage
pnpm dlx eas-cli update:republish    # roll back to an earlier update
```

The runtime version uses the fingerprint policy. A change to native code or config gives a new runtime, so an update can never reach a binary it doesn't match. Those changes need a new build. The app checks for an update on launch, starts from the cached bundle without waiting, and applies the new one on the next launch.

## Checks

```sh
pnpm tsc --noEmit
pnpm expo lint
pnpm expo export --platform web --max-workers 1
```
