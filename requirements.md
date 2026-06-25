a node server
listens to changes in "D:\Code\obsidian\test-v1\test.md"
# on every change
 - updates (renders) the index.html with the markdown (markdown - to html) - this file will be updated by obsidian, so we shouldn't have to worry about obisidan locking it, but mae shure that we don;t lock it, i.e obisidian should be able to read/write to the file while our process is running.
 - webiste should update when the the html file is changed.
 - if we can reduce the rendering cost then tha't a plus/bonus, if no then that's fine.
 - rendered html should be simple not with shit ton of js, do most of the processing on backend, webserver needs to be accessed on basic barebone kindle web browser.