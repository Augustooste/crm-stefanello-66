import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const AVATAR_BUCKET = "contact-avatars";
const SIGNED_URL_TTL = 60 * 60; // 1h

export function getAvatarBucket() {
  return AVATAR_BUCKET;
}

export function buildAvatarPath(tenantId: string, contactId: string, ext: string) {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  return `${tenantId}/${contactId}.${safeExt}`;
}

/**
 * Returns a short-lived signed URL for a stored avatar path.
 * `path` is the value saved in contacts.avatar_url (e.g. "<tenant_id>/<contact_id>.jpg").
 */
export function useContactAvatarUrl(path?: string | null) {
  return useQuery({
    queryKey: ["contact-avatar-url", path],
    enabled: !!path,
    staleTime: SIGNED_URL_TTL * 1000 * 0.8,
    queryFn: async () => {
      if (!path) return null;
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}

export async function uploadContactAvatar(params: {
  tenantId: string;
  contactId: string;
  file: File;
}): Promise<string> {
  const { tenantId, contactId, file } = params;
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = buildAvatarPath(tenantId, contactId, ext);
  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) throw error;
  return path;
}

export async function removeContactAvatar(path: string) {
  const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([path]);
  if (error) throw error;
}
