import { X } from 'lucide-react';
import type { ImageAttachment } from '../../ai-panel';

interface Props {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

/**
 * Staged reference images, inside the composer.
 *
 * Thumbnails rather than filename chips. On every other surface in this app an
 * attachment is a name — but the whole reason to attach an image HERE is that
 * it is a picture of what the screen should look like, and a row reading
 * `moodboard-final-3.png` tells you nothing about whether you attached the
 * right one.
 */
export function DesignAttachments({ images, onRemove }: Props) {
  if (images.length === 0) return null;
  return (
    <div className="design-dock-attachments">
      {images.map((image) => (
        <div key={image.id} className="design-dock-thumb">
          <img src={image.dataUrl} alt={image.sourceLabel} />
          <button
            type="button"
            className="design-dock-thumb-remove"
            onClick={() => onRemove(image.id)}
            aria-label={`Remove ${image.sourceLabel}`}
            title={image.sourceLabel}
          >
            <X size={9} strokeWidth={3} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default DesignAttachments;
