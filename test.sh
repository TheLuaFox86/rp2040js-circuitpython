oldpwd=$PWD
cd ../foxloader && make clean && make picoPC
cd $oldpwd
npm run mount0
rm -r mnt_dir/*
cp -a foxloader/out/. mnt_dir
npm run unmount
npm start
