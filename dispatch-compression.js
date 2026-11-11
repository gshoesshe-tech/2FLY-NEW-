'use strict';
// Compress locally. Original full-size bytes never leave the staff device.
window.compressDispatchPhoto=async function(file){
  if(!file)throw Error('Choose a photo first.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Use JPG, PNG, or WebP. Convert HEIC to JPG first.');
  if(file.size>20*1024*1024)throw Error('Original photo is over 20 MB. Choose a smaller camera size.');
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
  try{
    if(bitmap.width*bitmap.height>40000000)throw Error('Photo resolution is too large. Use a standard camera photo.');
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw Error('Photo compression is unavailable in this browser.');
    let result=null;
    for(const longest of [1800,1600,1400,1200]){
      const scale=Math.min(1,longest/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for(const quality of [.85,.76,.68]){result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(!result)throw Error('Could not compress photo.');if(result.size<=250000)break;}
      if(result&&result.size<=250000)break;
    }
    if(!result||result.size>600000)throw Error('Photo is too detailed to compress safely. Retake a closer, clearer picture.');
    return new File([result],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});
  }finally{bitmap.close();}
};
