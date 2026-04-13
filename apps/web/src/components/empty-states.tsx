import type { ReactNode } from "react";

export function EmptyPanel({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-panel">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
