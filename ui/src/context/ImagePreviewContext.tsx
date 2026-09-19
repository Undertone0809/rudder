import { ImagePreviewDialog, type ImagePreviewState } from "@/components/ImagePreviewDialog";
import { useLocation } from "@/lib/router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  const requestRef = useRef<ImagePreviewRequest | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeImagePreview = useCallback(() => {
    requestRef.current = null;
    setRequest(null);
  }, []);
  const openImagePreview = useCallback((preview: ImagePreviewRequest) => {
    if (!requestRef.current && typeof document !== "undefined") {
      const activeElement = document.activeElement;
      restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    }
    requestRef.current = preview;
    setRequest(preview);
  }, []);
  const restoreImagePreviewFocus = useCallback(() => {
    const element = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (element?.isConnected) element.focus();
  }, []);
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
        onCloseAutoFocus={restoreImagePreviewFocus}
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
