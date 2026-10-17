import { SpotifyPlayer } from "../../../Global/SpotifyPlayer.ts";

export default function GetHeaderUrl(data: any) {
  if (!data) return SpotifyPlayer.GetCover("xlarge") ?? undefined;

  const HeaderImage = typeof data === "object" ? data[0]?.url : JSON.parse(data)[0]?.url;

  if (!HeaderImage) return SpotifyPlayer.GetCover("xlarge") ?? undefined;

  const imageId = HeaderImage.substring(HeaderImage.lastIndexOf("/") + 1);
  return `spotify:image:${imageId}`;
}
