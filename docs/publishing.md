# GitHub publishing

Administrators can use **Publish site** to commit the latest Preview Data to
an existing GitHub file. The repository's connected build service handles the
subsequent site build and deployment.

## Connect a file

1. Open **Site Settings → Publishing** and paste the GitHub URL of the existing
   `.json` Preview Data file used by your site build. Use a branch, not a tag
   or commit ID. Studio does not create the file or configure the build service.
2. Select **Create GitHub token**. The link preselects the repository owner and
   **Contents: Read and write**. Select only the target repository and paste
   the token into **GitHub Token**. Organization-owned repositories may require
   approval from the organization.
3. Select **Check connection**, verify the repository, branch, and file path,
   then turn on **Publish to GitHub** and save. Saving a connection with this
   switch off keeps publishing disabled. If a URL could refer to multiple
   branches, use **Enter target manually**.

Connection checks confirm that the branch and regular JSON file can be read.
They do not check the file contents or guarantee permission to commit. Branch
rules must allow direct commits with the selected token.

The token is encrypted using `STUDIO_AUTH_SECRET`; it is never returned to the
browser or exported in Preview Data. Leave its field blank to keep it, enter
a new token to replace it, or disable publishing before deleting it. If you
change `STUDIO_AUTH_SECRET`, enter the token again.

## Publish

Select **Publish to GitHub**, review the repository, branch, and file in the
confirmation dialog, then confirm. Studio prepares and validates fresh Preview
Data and updates the connected file. **Updated on GitHub** confirms the commit;
check your build service for the site's deployment result. You can also generate,
copy, and download Preview Data without a GitHub connection.

Studio uses the file's Git Blob SHA and its latest commit metadata to recognize
unchanged data, without downloading the remote file. A new generation timestamp
alone does not create another commit. An externally changed file or a commit
without valid Studio metadata receives a fresh baseline on the next publish.

If the file changes during publishing, Studio stops with a conflict. If a
response is lost and the result cannot be confirmed, check the file's latest
GitHub commit before publishing again. Studio does not automatically resend
an uncertain update.
