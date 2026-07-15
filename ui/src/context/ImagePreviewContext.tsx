import { ImagePreviewDialog, type ImagePreviewState } from "@/components/ImagePreviewDialog";
import { useLocation } from "@/lib/router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ImagePreviewRequest extends ImagePreviewState {
  testId?: string;
  titleFallback?: string;
}

interface ImagePreviewContextValue {
  closeImagePreview(): void;
  openImagePreview(preview: ImagePreviewRequest): void;
}

const unavailableImagePreviewContext: ImagePreviewContextValue = {
  closeImagePreview: () => undefined,
  openImagePreview: () => undefined,
};

const ImagePreviewContext = createContext<ImagePreviewContextValue>(unavailableImagePreviewContext);

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [request, setRequest] = useState<ImagePreviewRequest | null>(null);
  const closeImagePreview = useCallback(() => setRequest(null), []);
  const openImagePreview = useCallback((preview: ImagePreviewRequest) => setRequest(preview), []);
  const value = useMemo(
    () => ({ closeImagePreview, openImagePreview }),
    [closeImagePreview, openImagePreview],
  );

  useEffect(() => {
    closeImagePreview();
  }, [closeImagePreview, location.hash, location.pathname, location.search]);

  return (
    <ImagePreviewContext.Provider value={value}>
      {children}
      <ImagePreviewDialog
        preview={request}
        onOpenChange={(open) => {
          if (!open) closeImagePreview();
        }}
        testId={request?.testId ?? "global-image-preview-dialog"}
        titleFallback={request?.titleFallback ?? "Image preview"}
      />
    </ImagePreviewContext.Provider>
  );
}

export function useImagePreview() {
  return useContext(ImagePreviewContext);
}
