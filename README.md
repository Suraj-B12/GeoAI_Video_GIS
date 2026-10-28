# GeoAI Video GIS

Start with `GIS_VIDEO_HANDOFF.md` for project context.

## IMPORTANT: `gis_sample.zip` contains essential data and is stored in Git LFS

`gis_sample.zip` (~139 MB) holds the sample GIS data the project depends on. It is tracked with **Git LFS** because it exceeds GitHub's 100 MB file limit.

### Getting the real file

```bash
git lfs install
git clone https://github.com/Suraj-B12/GeoAI_Video_GIS
cd GeoAI_Video_GIS
git lfs pull
```

If you already cloned without LFS, just run `git lfs install && git lfs pull`.

### How to tell it didn't download

If `gis_sample.zip` is only ~130 bytes and starts with `version https://git-lfs.github.com/spec/v1`, it is an LFS **pointer file**, not the data. It is not corrupt. Run `git lfs pull` to fetch the real zip. Do not proceed without the data.

### Without Git LFS

Open `gis_sample.zip` on the GitHub web page and click "Download" to get the real file directly.

If `git lfs` isn't installed: https://git-lfs.com (Git for Windows/macOS installers usually include it).
