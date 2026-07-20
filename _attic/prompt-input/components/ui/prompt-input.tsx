"use client";

import type {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
} from "react";
import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

/**
 * AI-powered prompt input component with attachment support
 * Designed for chat/agent interfaces with file and image uploads
 */
export interface PromptInputProps {
  /** Placeholder text for the input */
  placeholder?: string;
  /** Callback when user submits the prompt */
  onSubmit: (message: string, attachments?: File[]) => void | Promise<void>;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Whether the input is loading */
  isLoading?: boolean;
  /** Custom CSS class */
  className?: string;
  /** Maximum character length */
  maxLength?: number;
  /** Whether to allow file attachments */
  allowAttachments?: boolean;
}

export function PromptInput({
  placeholder = "Type your message...",
  onSubmit,
  disabled = false,
  isLoading = false,
  className = "",
  maxLength = 4096,
  allowAttachments = true,
}: PromptInputProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      setAttachments((prev) => [...prev, ...files]);
      // Reset the input so the same file can be selected again
      e.target.value = "";
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!input.trim() || disabled || isSubmitting || isLoading) return;

    setIsSubmitting(true);
    try {
      await onSubmit(input.trim(), attachments.length > 0 ? attachments : undefined);
      setInput("");
      setAttachments([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Ctrl/Cmd+Enter, insert newline on Shift+Enter
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSubmit({ preventDefault: () => {} } as FormEvent<HTMLFormElement>);
    }
  };

  const charCount = input.length;
  const isNearLimit = charCount > maxLength * 0.8;
  const isAtLimit = charCount >= maxLength;

  return (
    <div className={`prompt-input-container ${className}`}>
      <form onSubmit={(e) => void handleSubmit(e)} className="prompt-input-form">
        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div className="prompt-input-attachments">
            {attachments.map((file, index) => (
              <div key={`${file.name}-${index}`} className="prompt-input-attachment">
                <div className="prompt-input-attachment-info">
                  <span className="prompt-input-attachment-name">{file.name}</span>
                  <span className="prompt-input-attachment-size">
                    {formatFileSize(file.size)}
                  </span>
                </div>
                <button
                  type="button"
                  className="prompt-input-attachment-remove"
                  onClick={() => removeAttachment(index)}
                  aria-label={`Remove ${file.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input area */}
        <div className="prompt-input-body">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleTextChange(e)}
            onKeyDown={(e) => handleKeyDown(e)}
            placeholder={placeholder}
            disabled={disabled || isLoading || isSubmitting}
            maxLength={maxLength}
            className="prompt-input-textarea"
            rows={1}
          />

          {/* Control buttons */}
          <div className="prompt-input-controls">
            {allowAttachments && (
              <>
                <button
                  type="button"
                  className="prompt-input-attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || isLoading || isSubmitting}
                  aria-label="Attach files"
                  title="Attach files or images"
                >
                  📎
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={(e) => handleFileChange(e)}
                  className="prompt-input-file-input"
                  style={{ display: "none" }}
                />
              </>
            )}

            {/* Character count */}
            {charCount > 0 && (
              <span
                className={`prompt-input-char-count ${isAtLimit ? "is-limit" : isNearLimit ? "is-warning" : ""}`}
              >
                {charCount}/{maxLength}
              </span>
            )}

            {/* Submit button */}
            <button
              type="submit"
              className="prompt-input-submit-btn"
              disabled={!input.trim() || disabled || isLoading || isSubmitting || isAtLimit}
              aria-label="Send message"
            >
              {isSubmitting || isLoading ? "..." : "↑"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * File attachment badge component
 */
export function AttachmentBadge({
  file,
  onRemove,
}: {
  file: File;
  onRemove?: () => void;
}): React.JSX.Element {
  return (
    <div className="attachment-badge">
      <span className="attachment-badge-icon">📎</span>
      <span className="attachment-badge-name" title={file.name}>
        {file.name}
      </span>
      {onRemove && (
        <button
          type="button"
          className="attachment-badge-remove"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          ✕
        </button>
      )}
    </div>
  );
}
