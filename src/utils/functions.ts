import jwt from 'jsonwebtoken'
import mongoose from 'mongoose';



const generateToken = (id:mongoose.Types.ObjectId)=>{

    const payload = {
        id:id
    }


    const secret = process.env.JWT_SECRET;

    if(!secret){
        console.error("Please configure JWT_SECRET in environment variables");
        throw new Error("Configure environment variables");
    }

    const token = jwt.sign(payload,secret,{
        expiresIn:'30d'
    })

    return token;
}



export default generateToken;

