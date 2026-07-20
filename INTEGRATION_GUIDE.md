# PromptInput Integration Guide

This guide shows exactly where and how to integrate the PromptInput component into your existing codexdesktop UI.

## Option 1: Replace textarea in ChatPane (Recommended)

### Location
File: `src/renderer/src/ChatPane.tsx`

### Current state
Look for the message input area (likely using a textarea or similar).

### Integration steps

1. **Add imports at the top of ChatPane.tsx**:
```tsx
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
```

2. **Replace the textarea with PromptInput**:

Before:
```tsx
<textarea
  value={input}
  onChange={(e) => setInput(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSend(input);
      setInput('');
    }
  }}
  placeholder="Send a message..."
/>
<button onClick={() => handleSend(input)}>Send</button>
```

After:
```tsx
<PromptInput
  placeholder="Send a message..."
  onSubmit={async (message, attachments) => {
    await handleSend(message, attachments);
  }}
  disabled={isBusy}
  isLoading={isBusy}
/>
```

3. **Update handleSend to accept attachments**:

Before:
```tsx
const handleSend = (text: string) => {
  if (!text.trim()) return;
  onSend(text);
};
```

After:
```tsx
const handleSend = async (text: string, attachments?: File[]) => {
  if (!text.trim()) return;
  
  // Convert File objects to ChatAttachment if needed
  let chatAttachments: ChatAttachment[] | undefined;
  if (attachments && attachments.length > 0) {
    chatAttachments = attachments.map((file) => ({
      id: nanoid(),
      name: file.name,
      size: file.size,
      type: file.type,
      // Add any other properties needed by ChatAttachment
    }));
  }
  
  await onSend(text, chatAttachments);
};
```

---

## Option 2: Add to ChatControls for Compose Area

### Location
File: `src/renderer/src/ChatControls.tsx`

### Integration steps

1. **Add imports**:
```tsx
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
```

2. **Create a new component for compose area**:
```tsx
export function ComposeArea({
  onSend,
  disabled,
}: {
  onSend: (message: string, attachments?: File[]) => Promise<void>;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <PromptInput
      placeholder="Compose a message..."
      onSubmit={onSend}
      disabled={disabled}
      maxLength={2000}
      allowAttachments={true}
    />
  );
}
```

3. **Add to ChatControls JSX**:
```tsx
<section className="compose-section">
  <h3>New Message</h3>
  <ComposeArea
    onSend={handleCompose}
    disabled={isComposing}
  />
</section>
```

---

## Option 3: Create Standalone ChatMessageInput Component

### Create new file
`src/renderer/src/ChatMessageInput.tsx`

```tsx
import { useState } from 'react';
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
import type { ChatAttachment } from '../../shared/ipc';
import { nanoid } from 'nanoid';

export interface ChatMessageInputProps {
  onSendMessage: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatMessageInput({
  onSendMessage,
  disabled = false,
  placeholder = 'Type a message...',
}: ChatMessageInputProps): React.JSX.Element {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (message: string, files?: File[]) => {
    if (!message.trim()) return;

    setIsSubmitting(true);
    try {
      let attachments: ChatAttachment[] | undefined;
      if (files && files.length > 0) {
        attachments = files.map((file) => ({
          id: nanoid(),
          name: file.name,
          size: file.size,
          type: file.type,
        }));
      }

      await onSendMessage(message, attachments);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PromptInput
      placeholder={placeholder}
      onSubmit={handleSubmit}
      disabled={disabled || isSubmitting}
      isLoading={isSubmitting}
      maxLength={4096}
      allowAttachments={true}
    />
  );
}
```

### Usage in ChatPane
```tsx
import { ChatMessageInput } from './ChatMessageInput';

// In your JSX:
<ChatMessageInput
  onSendMessage={onSend}
  disabled={isBusy}
  placeholder="Send a message..."
/>
```

---

## Step 4: Handle ChatAttachment Type

If your app uses a ChatAttachment interface, make sure it's compatible:

```tsx
// src/shared/ipc.ts (or wherever ChatAttachment is defined)
export interface ChatAttachment {
  id: string;           // nanoid() generated
  name: string;         // file.name
  size: number;         // file.size
  type: string;         // file.type (mime type)
  // Add any other properties your app needs
  url?: string;         // After upload
  uploadedAt?: number;  // Timestamp
}
```

---

## Step 5: Style Integration

### Option A: Use default styles
The component comes with complete styling. Just import the CSS:
```tsx
import '@/components/ui/prompt-input.css';
```

### Option B: Customize colors
Add CSS variables to your main CSS file:
```css
:root {
  --primary: #3b82f6;              /* Button color */
  --border-color: #e5e7eb;         /* Input border */
  --bg-secondary: #ffffff;         /* Input background */
  --text-primary: #111827;         /* Text color */
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --primary-dark: #60a5fa;
    --border-color-dark: #374151;
    --bg-secondary-dark: #1f2937;
    --text-primary-dark: #f3f4f6;
  }
}
```

### Option C: Add custom class
```tsx
<PromptInput
  onSubmit={handleSubmit}
  className="my-custom-prompt-input"
/>
```

```css
.my-custom-prompt-input .prompt-input-submit-btn {
  background: #10b981; /* Green */
}
```

---

## Step 6: API Integration Example

### Handle message with attachments on your backend

```tsx
const handleSend = async (message: string, attachments?: ChatAttachment[]) => {
  const formData = new FormData();
  formData.append('message', message);
  
  if (attachments) {
    attachments.forEach((att, idx) => {
      formData.append(`attachments[${idx}][id]`, att.id);
      formData.append(`attachments[${idx}][name]`, att.name);
      formData.append(`attachments[${idx}][size]`, att.size.toString());
      formData.append(`attachments[${idx}][type]`, att.type);
    });
  }

  const response = await fetch('/api/messages', {
    method: 'POST',
    body: formData,
  });

  const result = await response.json();
  console.log('Message sent:', result);
};
```

---

## Complete Example: Minimal Chat Component

Here's a complete minimal example you can copy and paste:

```tsx
// src/renderer/src/MinimalChat.tsx
import { useState } from 'react';
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';

export function MinimalChat(): React.JSX.Element {
  const [messages, setMessages] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (message: string) => {
    setIsLoading(true);
    try {
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Add message to display
      setMessages((prev) => [...prev, message]);

      // In real app, send to API:
      // await api.sendMessage(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="minimal-chat">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className="message">
            {msg}
          </div>
        ))}
      </div>

      <PromptInput
        placeholder="Send a message..."
        onSubmit={handleSubmit}
        disabled={isLoading}
        isLoading={isLoading}
      />
    </div>
  );
}

// Styling
const styles = `
  .minimal-chat {
    display: flex;
    flex-direction: column;
    height: 100vh;
    gap: 16px;
    padding: 16px;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    gap: 8px;
    display: flex;
    flex-direction: column;
  }

  .message {
    padding: 12px;
    background: #f0f0f0;
    border-radius: 8px;
    word-break: break-word;
  }
`;
```

---

## Testing Your Integration

### Test checklist

- [ ] Component renders without errors
- [ ] Can type in the input
- [ ] Textarea auto-expands as you type
- [ ] Ctrl+Enter sends the message
- [ ] Message appears in your chat/UI
- [ ] Loading state shows during submission
- [ ] File attachment button works (if enabled)
- [ ] Can add/remove attachments
- [ ] Keyboard shortcuts work (Ctrl+Enter)
- [ ] Mobile works (touch buttons, etc.)
- [ ] Styles look correct (colors, spacing)
- [ ] Dark mode works

### Debug tips

**Issue**: Component not visible
- Check CSS is imported
- Check container width is set
- Check z-index isn't causing overlap

**Issue**: Styles look wrong
- Verify CSS file is imported
- Check for CSS conflicts with other styles
- Check browser dev tools for style overrides

**Issue**: Submit not working
- Check `onSubmit` callback is being called
- Check async/await is working correctly
- Check console for errors

---

## File Locations Reference

After integration, your structure looks like:

```
codexdesktop/
├── src/
│   ├── components/
│   │   ├── ui/
│   │   │   ├── prompt-input.tsx       ← Main component
│   │   │   ├── prompt-input.css       ← Styles
│   │   │   └── index.ts
│   │   ├── ChatMessageInput.tsx       ← Optional wrapper (if you create it)
│   │   └── PromptInputExample.tsx     ← Reference example
│   └── renderer/src/
│       ├── ChatPane.tsx               ← Integrate here (Option 1)
│       ├── ChatControls.tsx           ← Or integrate here (Option 2)
│       └── MinimalChat.tsx            ← Or create new component (Option 3)
├── PROMPT_INPUT_DOCS.md               ← Reference docs
├── PROMPT_INPUT_QUICK_START.md        ← Quick reference
└── INTEGRATION_GUIDE.md               ← This file
```

---

## Next Steps

1. Choose which option (1, 2, or 3) above
2. Make the import changes
3. Replace/add the PromptInput component
4. Test with the checklist above
5. Customize styling if needed
6. Deploy!

For more help, see:
- `PROMPT_INPUT_QUICK_START.md` - Quick reference
- `PROMPT_INPUT_DOCS.md` - Full documentation
- `src/components/PromptInputExample.tsx` - Working example

---

**Ready to integrate?** Pick Option 1, 2, or 3 above and follow the steps!
