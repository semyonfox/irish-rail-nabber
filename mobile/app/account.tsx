import { isClerkAPIResponseError, useAuth, useSignIn } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { clerkKey, useApi } from "../src/session";
import {
  Button,
  Card,
  Copy,
  Field,
  Notice,
  Row,
  Screen,
  Skeleton,
  useAnnounce,
} from "../src/ui";
import { useResource } from "../src/use-resource";

function SignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  const [resendBlockedUntil, setResendBlockedUntil] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!resendBlockedUntil) return;
    const update = () =>
      setSeconds(
        Math.max(0, Math.ceil((resendBlockedUntil - Date.now()) / 1000)),
      );
    update();
    const timer = setInterval(update, 1_000);
    const end = setTimeout(
      () => {
        clearInterval(timer);
        update();
      },
      Math.max(0, resendBlockedUntil - Date.now()) + 250,
    );
    return () => {
      clearInterval(timer);
      clearTimeout(end);
    };
  }, [resendBlockedUntil]);

  async function sendCode() {
    if (!isLoaded || busy || (factorId && Date.now() < resendBlockedUntil))
      return;
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setBusy("send");
    try {
      let id = factorId;
      if (!id) {
        const attempt = await signIn.create({ identifier: address });
        const factor = attempt.supportedFirstFactors?.find(
          (item) => item.strategy === "email_code",
        );
        id = factor?.emailAddressId ?? null;
      }
      if (!id) {
        setError(
          "Email code sign-in is unavailable for this account. Sign in on the web dashboard.",
        );
        return;
      }
      await signIn.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: id,
      });
      setFactorId(id);
      setCode("");
      setSeconds(30);
      setResendBlockedUntil(Date.now() + 30_000);
    } catch {
      setError(
        "Could not send a code. Check your email address and connection, then try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!isLoaded || busy || !factorId) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the six-digit code from your email.");
      return;
    }
    setError(null);
    setBusy("verify");
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: "email_code",
        code: code.trim(),
      });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        await setActive({ session: attempt.createdSessionId });
      } else {
        setError(
          "This account needs another verification step. Finish signing in on the web dashboard.",
        );
      }
    } catch (failure) {
      const invalid =
        isClerkAPIResponseError(failure) &&
        failure.errors.some(
          ({ code }) =>
            code === "form_code_incorrect" || code === "verification_expired",
        );
      setError(
        invalid
          ? "That code is incorrect or expired. Check it or request a new one."
          : "Could not verify the code. Check your connection and try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (!isLoaded) return <Skeleton label="Loading sign-in" />;

  return (
    <View style={{ gap: 14, maxWidth: 420 }}>
      <Copy variant="section" accessibilityRole="header">
        {factorId ? "Check your email" : "Sign in"}
      </Copy>
      {factorId ? (
        <>
          <Copy tone="secondary">Enter the code sent to {email.trim()}.</Copy>
          <Field
            key="code"
            label="Verification code"
            value={code}
            // accept pasted codes like "123 456"
            onChangeText={(value) =>
              setCode(value.replace(/\D/g, "").slice(0, 6))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            returnKeyType="go"
            onSubmitEditing={() => void verify()}
            editable={!busy}
          />
          {error ? (
            <Copy tone="bad" accessibilityLiveRegion="polite">
              {error}
            </Copy>
          ) : null}
          <Button
            label={busy === "verify" ? "Verifying…" : "Verify code"}
            primary
            busy={busy != null}
            onPress={verify}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              label={
                seconds > 0
                  ? `Resend in ${seconds}s`
                  : busy === "send"
                    ? "Sending…"
                    : "Resend code"
              }
              busy={busy != null}
              disabled={seconds > 0}
              onPress={sendCode}
            />
            <Button
              label="Change email"
              busy={busy != null}
              onPress={() => {
                setFactorId(null);
                setCode("");
                setError(null);
              }}
            />
          </View>
        </>
      ) : (
        <>
          <Copy tone="secondary">
            Use the email address on your Traein account.
          </Copy>
          <Field
            key="email"
            label="Email address"
            value={email}
            onChangeText={setEmail}
            inputMode="email"
            autoComplete="email"
            returnKeyType="go"
            editable={!busy}
            onSubmitEditing={() => void sendCode()}
          />
          {error ? (
            <Copy tone="bad" accessibilityLiveRegion="polite">
              {error}
            </Copy>
          ) : null}
          <Button
            label={busy === "send" ? "Sending…" : "Send sign-in code"}
            primary
            busy={busy != null}
            onPress={sendCode}
          />
        </>
      )}
    </View>
  );
}

const roles = new Map([
  ["free", "Free"],
  ["coffee", "Coffee"],
  ["pro", "Pro"],
  ["admin", "Admin"],
]);

function AccountDetails() {
  const { me } = useApi();
  const { signOut } = useAuth();
  const account = useResource(me, { maxAge: 60_000 });
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  async function leave() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      await signOut();
    } catch {
      setSignOutError(true);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Screen
      title="Account"
      refresh={account.refresh}
      refreshing={account.refreshing}
    >
      {account.error ? (
        <Notice
          title={
            account.data
              ? "Showing the last account details"
              : "Account details unavailable"
          }
          darken
          retry={account.refresh}
        >
          {account.error}
        </Notice>
      ) : null}
      {account.kind === "loading" ? <Skeleton label="Loading account" /> : null}
      {account.data ? (
        <Card>
          <Row first>
            <View style={{ flex: 1 }}>
              <Copy variant="label">
                {account.data.display_name || "Email address"}
              </Copy>
              <Copy variant="small" tone="secondary" selectable>
                {account.data.email}
              </Copy>
            </View>
          </Row>
          <Row>
            <Copy variant="label" style={{ flex: 1 }}>
              Plan
            </Copy>
            <Copy variant="small" tone="secondary">
              {roles.get(account.data.role) ?? account.data.role}
            </Copy>
          </Row>
        </Card>
      ) : null}
      {signOutError ? (
        <Notice title="Could not sign out" darken>
          Check your connection and try again.
        </Notice>
      ) : null}
      <View style={{ alignItems: "flex-start" }}>
        <Button
          label={signingOut ? "Signing out…" : "Sign out"}
          busy={signingOut}
          onPress={leave}
        />
      </View>
    </Screen>
  );
}

function ConfiguredAccount() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (isLoaded && isSignedIn) return <AccountDetails key={userId} />;
  return (
    <Screen title="Account">
      {isLoaded ? <SignIn /> : <Skeleton label="Checking your session" />}
    </Screen>
  );
}

export default function Account() {
  if (clerkKey) return <ConfiguredAccount />;
  return (
    <Screen title="Account">
      <Notice title="Sign-in isn’t configured">
        Live trains, station boards and buses are available without an account.
      </Notice>
    </Screen>
  );
}
