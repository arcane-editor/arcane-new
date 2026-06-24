/**
 * StreamingIndicator — three animated dots shown at the end of a streaming message.
 */

function StreamingIndicator() {
  return (
    <span className="ai-streaming-dots">
      <span className="ai-streaming-dot" />
      <span className="ai-streaming-dot" />
      <span className="ai-streaming-dot" />
    </span>
  );
}

export default StreamingIndicator;
