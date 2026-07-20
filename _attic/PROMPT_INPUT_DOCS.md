# PromptInput Component Documentation

A modern, AI-powered prompt input component for chat interfaces with support for file attachments and smart shortcuts.

## Installation

The component has been installed to your codexdesktop project. No additional installation steps required.

### Files Added

```
src/components/
├── ui/
│   ├── prompt-input.tsx       # Main component
│   ├── prompt-input.css       # Styles
│   └── index.ts               # Exports
├── PromptInputExample.tsx      # Example usage
└── PromptInputExample.css      # Example styles
```

## Quick Start

### 1. Import the component

```tsx
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
```

### 2. Basic usage

```tsx
import { useState } from 'react';
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';

export function MyChat() {
  const [messages, setMessages] = useState<string[]>([]);

  const handleSubmit = async (message: string, attachments?: File[]) => {
    // Handle the message
    setMessages(prev => [...prev, message]);
    
    // Handle attachments if provided
    if (attachments) {
      console.log('Attachments:', attachments);
      // Upload files, process them, etc.
    }
  };

  return (
    <PromptInput
      placeholder="Type your message..."
      onSubmit={handleSubmit}
    />
  );
}
```

## API Reference

### PromptInput

Main component for user input with attachment support.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `placeholder` | `string` | "Type your message..." | Placeholder text |
| `onSubmit` | `(message: string, attachments?: File[]) => void \| Promise<void>` | **Required** | Callback when user submits |
| `disabled` | `boolean` | `false` | Disable the input |
| `isLoading` | `boolean` | `false` | Show loading state |
| `className` | `string` | `""` | Additional CSS classes |
| `maxLength` | `number` | `4096` | Maximum character count |
| `allowAttachments` | `boolean` | `true` | Enable file attachments |

#### Example with all props

```tsx
<PromptInput
  placeholder="Ask me anything..."
  onSubmit={async (message, attachments) => {
    // Send to API
    await api.sendMessage(message, attachments);
  }}
  disabled={isLoading}
  isLoading={isLoading}
  maxLength={2000}
  allowAttachments={true}
  className="my-custom-class"
/>
```

### AttachmentBadge

Standalone component for displaying a single file attachment.

```tsx
import { AttachmentBadge } from '@/components/ui';

export function MyAttachments({ files }: { files: File[] }) {
  return (
    <div>
      {files.map((file, idx) => (
        <AttachmentBadge
          key={idx}
          file={file}
          onRemove={() => console.log('Remove', file.name)}
        />
      ))}
    </div>
  );
}
```

## Features

### 1. Auto-expanding textarea
- Grows as user types, up to a maximum of 200px
- Returns to original size when emptied

### 2. Smart keyboard shortcuts
- **Ctrl/Cmd + Enter**: Submit message
- **Enter**: Insert newline (in most contexts)

### 3. File attachments
- Click the 📎 button to select files
- Multiple file selection supported
- Visual preview of attached files
- Remove attachments before sending
- Displays file size and name

### 4. Character counter
- Shows current/max character count
- Warning state at 80% of limit
- Error state at 100% of limit

### 5. Responsive design
- Mobile-friendly
- Touch-friendly buttons
- Scrollable message areas

### 6. Accessibility
- ARIA labels on all buttons
- Keyboard navigation support
- Semantic HTML structure
- Focus management

### 7. Dark mode support
- Automatic dark mode detection
- CSS custom properties for theming
- Proper contrast ratios

## Styling & Customization

### CSS Custom Properties

The component uses CSS custom properties for theming. You can override them in your CSS:

```css
:root {
  --primary: #3b82f6;
  --primary-dark: #60a5fa;
  --border-color: #e5e7eb;
  --border-color-dark: #374151;
  --bg-secondary: #ffffff;
  --bg-secondary-dark: #1f2937;
  --bg-tertiary: #f9fafb;
  --bg-tertiary-dark: #111827;
  --bg-hover: #f3f4f6;
  --bg-hover-dark: #374151;
  --text-primary: #111827;
  --text-primary-dark: #f3f4f6;
  --text-secondary: #6b7280;
  --text-secondary-dark: #d1d5db;
  --text-tertiary: #9ca3af;
  --text-tertiary-dark: #6b7280;
  --text-disabled: #d1d5db;
}
```

### Custom styling example

```css
/* Override default styles */
.my-custom-input .prompt-input-textarea {
  font-size: 16px;
  line-height: 1.6;
}

.my-custom-input .prompt-input-submit-btn {
  background: #10b981; /* Green */
}
```

```tsx
<PromptInput
  className="my-custom-input"
  onSubmit={handleSubmit}
/>
```

## Integration with existing chat UI

### Example: Replacing textarea in ChatPane

Before:
```tsx
<textarea
  value={input}
  onChange={(e) => setInput(e.target.value)}
  placeholder="Type a message..."
/>
```

After:
```tsx
<PromptInput
  placeholder="Type a message..."
  onSubmit={async (message, attachments) => {
    await sendMessage(message, attachments);
  }}
  disabled={isBusy}
  isLoading={isLoading}
/>
```

### Example: In ChatControls or chat-related component

```tsx
import { PromptInput } from '@/components/ui';
import '@/components/ui/prompt-input.css';
import type { ChatAttachment } from '../../shared/ipc';

export function ChatInputArea({
  onSend,
  disabled,
}: {
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  disabled: boolean;
}) {
  return (
    <PromptInput
      placeholder="Send a message... (Ctrl+Enter)"
      onSubmit={async (message, files) => {
        const attachments = files
          ? files.map((f) => ({
              id: nanoid(),
              name: f.name,
              size: f.size,
              type: f.type,
            }))
          : undefined;
        await onSend(message, attachments);
      }}
      disabled={disabled}
      maxLength={4096}
      allowAttachments
    />
  );
}
```

## Handling File Uploads

```tsx
const handleSubmit = async (message: string, attachments?: File[]) => {
  if (attachments && attachments.length > 0) {
    // Upload files to server
    const formData = new FormData();
    formData.append('message', message);
    
    attachments.forEach((file, idx) => {
      formData.append(`file_${idx}`, file);
    });

    const response = await fetch('/api/messages', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();
    console.log('Message sent with attachments:', result);
  } else {
    // Send just the message
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }
};
```

## Examples

See `src/components/PromptInputExample.tsx` for a complete working example with:
- Message display
- Attachment handling
- Loading states
- Error handling

To use the example:
```tsx
import { PromptInputExample } from '@/components/PromptInputExample';
import '@/components/PromptInputExample.css';

export function App() {
  return <PromptInputExample />;
}
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Performance Notes

- Component is optimized for performance
- Auto-resize uses passive listeners
- File operations are non-blocking
- Handles large character counts efficiently

## Accessibility Features

- ✅ ARIA labels on all interactive elements
- ✅ Keyboard navigation (Tab, Enter, Ctrl+Enter)
- ✅ Screen reader friendly
- ✅ Focus indicators
- ✅ Semantic HTML
- ✅ High contrast support

## Troubleshooting

### Styles not applying
Make sure you import the CSS file:
```tsx
import '@/components/ui/prompt-input.css';
```

### Component not visible
Check that:
1. Container has sufficient width
2. CSS is imported
3. React version is 16.8+ (hooks required)

### File uploads not working
- Check browser file API support
- Verify `allowAttachments` prop is `true`
- Check browser console for errors

### Textarea not expanding
- Check CSS isn't overriding the height
- Verify `max-height` isn't set too low in custom CSS

## Future Enhancements

Potential additions to consider:
- Rich text formatting (bold, italic, etc.)
- Emoji picker
- @ mentions / autocomplete
- Drag-and-drop file support
- Image preview thumbnails
- Voice input support
- Message history / up arrow cycling
- Custom button actions

## License

MIT - Same as codexdesktop
