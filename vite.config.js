import { defineConfig } from "vite";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const repoName = repository.includes("/") ? repository.split("/")[1] : "";
const isUserPageRepository = /\.github\.io$/i.test(repoName);

export default defineConfig({
  base: process.env.GITHUB_ACTIONS
    ? isUserPageRepository || !repoName
      ? "/"
      : `/${repoName}/`
    : "/",
});
