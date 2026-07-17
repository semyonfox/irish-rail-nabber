import { Link } from "react-router-dom";
import type { CombinedError } from "urql";

interface Props {
  error: CombinedError;
  onRetry?: () => void;
  title?: string;
}

function statusOf(error: CombinedError) {
  return error.response?.status;
}

export default function RequestError({ error, onRetry, title = "Data unavailable" }: Props) {
  const rateLimited = statusOf(error) === 429 || /rate limit/i.test(error.message);
  const offline = error.networkError != null && !rateLimited;

  return (
    <div className="request-error" role="alert">
      <div>
        <h3>{rateLimited ? "Daily request limit reached" : title}</h3>
        <p>
          {rateLimited
            ? "This view has used today’s API allowance. It will reset automatically, or you can choose a plan with a larger allowance."
            : offline
              ? "The service could not be reached. Your connection may be offline, or the live API may be restarting."
              : "The live service returned an error. Retry in a moment; no data has been hidden intentionally."}
        </p>
      </div>
      <div className="request-error-actions">
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {rateLimited ? <Link to="/pricing">View plans</Link> : null}
      </div>
    </div>
  );
}
