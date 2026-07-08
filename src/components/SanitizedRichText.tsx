import { sanitizeRichTextHtml } from '../domain/richTextSanitizer';

interface SanitizedRichTextProps {
  html?: string | null;
  fallback?: string;
  className?: string;
}

export default function SanitizedRichText({
  html,
  fallback = '',
  className,
}: SanitizedRichTextProps) {
  const sanitized = sanitizeRichTextHtml(html || fallback);
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
