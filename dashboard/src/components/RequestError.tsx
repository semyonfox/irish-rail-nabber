import { Link } from "react-router-dom";
import type { CombinedError } from "urql";
import { isAuthError } from "../utils/errors";
import { Icon } from "./ui";

interface Props {
  error: CombinedError;
  onRetry?: () => void;
  title?: string;
  bare?: boolean;
}

function statusOf(error: CombinedError) {
  return error.response?.status;
}

export default function RequestError({
  error,
  onRetry,
  title = "Data unavailable",
  bare = false,
}: Props) {
  const auth = isAuthError(error);
  const rateLimited = statusOf(error) === 429 || /rate limit/i.test(error.message);
  const offline = error.networkError != null && !rateLimited;

  const heading = auth
    ? "Sign in to continue"
    : rateLimited
      ? "Daily request limit reached"
      : title;
  const body = auth
    ? "This request needs an account. Live rail and bus departures stay open to everyone."
    : rateLimited
      ? "This view has used today's data allowance. It resets automatically, or you can choose a plan with a larger allowance."
      : offline
        ? "The service could not be reached. Your connection may be offline, or the live API may be restarting."
        : "The live service returned an error. Try again in a moment.";

  return (
    <div
      className={`notice ${bare ? "" : "card rise"}`}
      role={auth ? undefined : "alert"}
      data-kind={auth ? "auth" : "error"}
    >
      <div className="flex min-w-0 items-start gap-4">
        <span className="notice-icon">
          <Icon name={auth ? "lock" : "alert"} />
        </span>
        <div className="min-w-0">
          <h3>{heading}</h3>
          <p>{body}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {auth ? (
          <>
            <Link to="/login" className="btn btn-quiet">
              Log in
            </Link>
            <Link to="/register" className="btn btn-primary">
              Create free account
            </Link>
          </>
        ) : (
          <>
            {onRetry ? (
              <button type="button" className="btn btn-quiet" onClick={onRetry}>
                <Icon name="refresh" />
                Retry
              </button>
            ) : null}
            {rateLimited ? (
              <Link to="/pricing" className="btn btn-primary">
                View plans
              </Link>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
