/**
 * Example integration of PromptInput component in codexdesktop
 *
 * Usage:
 * 1. Import the component: import { PromptInput } from '@/components/ui';
 * 2. Import the styles: import '@/components/ui/prompt-input.css';
 * 3. Use in your chat/message component (see example below)
 */

import { useState } from 'react';
import { PromptInput } from './ui';
import './ui/prompt-input.css';

export function PromptInputExample(): React.JSX.Element {
  const [messages, setMessages] = useState<Array<{ id: string; text: string; attachments?: File[] }>>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (message: string, attachments?: File[]) => {
    setIsLoading(true);
    try {
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Add message to display
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          text: message,
          attachments,
        },
      ]);

      // Here you would typically:
      // 1. Send to your backend/API
      // 2. Handle file uploads if needed
      // 3. Process attachments
      console.log('Message submitted:', { message, attachmentCount: attachments?.length ?? 0 });

      if (attachments && attachments.length > 0) {
        console.log('Attachments:', attachments.map((f) => ({ name: f.name, size: f.size, type: f.type })));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="prompt-input-example-container">
      <div className="prompt-input-example-header">
        <h2>Prompt Input Example</h2>
        <p>Send messages with optional file attachments</p>
      </div>

      {/* Messages display */}
      <div className="prompt-input-example-messages">
        {messages.length === 0 ? (
          <p className="prompt-input-example-empty">No messages yet</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="prompt-input-example-message">
              <p>{msg.text}</p>
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="prompt-input-example-attachments-list">
                  <p className="prompt-input-example-attachments-label">Attachments:</p>
                  <ul>
                    {msg.attachments.map((file, idx) => (
                      <li key={`${file.name}-${idx}`}>
                        {file.name} ({formatFileSize(file.size)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Prompt input */}
      <div className="prompt-input-example-input">
        <PromptInput
          placeholder="Type your message... (Ctrl+Enter to send)"
          onSubmit={handleSubmit}
          disabled={isLoading}
          isLoading={isLoading}
          maxLength={2000}
          allowAttachments
        />
      </div>
    </div>
  );
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
